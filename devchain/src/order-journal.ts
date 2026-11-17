/**
 * The executor's order journal (issue #93): the record of the order placed for each intent, kept in the
 * console's executor API (`CONSOLE_EXECUTOR_ROUTES.order`), because the executor container has no disk
 * of its own. A real venue writes "placing" before it sends an order and refuses to send one when it
 * cannot write that first, so a restart or a retry always finds out about an earlier attempt.
 */
import {
  CONSOLE_EXECUTOR_ROUTES,
  consoleErrorSchema,
  hashExecutorRecord,
  putExecutorVenueRequestSchema,
  putVenueOrderRequestSchema,
  storedVenueOrderSchema,
  type ExecutorVenue,
  type VenueOrderRecord,
} from "@mandate/shared";
import type { Hex } from "viem";

export interface OrderJournal {
  /** The latest version of an intent's record, or null when it has none. Throws when it cannot be read. */
  get(intentId: number): Promise<VenueOrderRecord | null>;
  /** Stores a new version (a higher revision). Throws when it was not stored. */
  put(record: VenueOrderRecord): Promise<void>;
}

/** Signs a record's 32-byte hash with the executor key (EIP-191, raw bytes). */
export type RecordSigner = (hash: Hex) => Promise<Hex>;

export interface ConsoleJournalOptions {
  consoleUrl: string;
  sign: RecordSigner;
  /**
   * The contract whose orders this journal holds. Reads name it (#95: one executor serves every mandate's
   * contract, and the same intent id exists on each); writes carry it in the signed record.
   */
  deployment: { chainId: number; policy: string };
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /**
   * Waits before each new try of a request that failed in a way that passes with time: no answer (the
   * console is starting, busy, or compiling the route on its first request in development), its own
   * failure (5xx), or, for a write, an intent it has not seen on chain yet (it follows the chain a moment
   * behind the executor). Reading again is harmless; so is writing the same signed record again (the
   * console answers 200 for one it holds), and nothing has gone to Gemini before the write is stored.
   * Default: 0.25, 0.5, 1, 2 and 4 seconds, so about 8 seconds in all before the executor waits longer.
   */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/** A failure that may pass with time: no answer, the console's own failure, or an intent not seen yet. */
class PassingConsoleError extends Error {
  override readonly name = "PassingConsoleError";
}

async function consoleAnswer(response: Response): Promise<{ code: string | null; text: string }> {
  const parsed = consoleErrorSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success
    ? { code: parsed.data.error.code, text: `${parsed.data.error.code}: ${parsed.data.error.message}` }
    : { code: null, text: `HTTP ${String(response.status)}` };
}

async function answerText(response: Response): Promise<string> {
  return (await consoleAnswer(response)).text;
}

export function consoleOrderJournal(options: ConsoleJournalOptions): OrderJournal {
  const base = options.consoleUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const deploymentQuery = new URLSearchParams({
    chainId: String(options.deployment.chainId),
    policy: options.deployment.policy.toLowerCase(),
  }).toString();
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await send(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new PassingConsoleError(
        `the console at ${base} did not answer (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
  };
  /** Runs `once` again after each failure that may pass, waiting `delays` in turn; then gives up. */
  async function retrying<T>(once: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof PassingConsoleError)) throw error;
        if (delay === undefined) {
          throw new Error(`${error.message} (${String(attempt + 1)} tries)`, { cause: error });
        }
        await sleep(delay);
      }
    }
  }
  return {
    get: (intentId) =>
      retrying(async () => {
        const response = await request(`${CONSOLE_EXECUTOR_ROUTES.order(intentId)}?${deploymentQuery}`, {
          headers: { accept: "application/json" },
        });
        // Only the console's own "no record" counts as none: any other 404 (a proxy, an older console
        // without this route) is an outage, or a restart would send an order that may already exist.
        if (response.status === 404) {
          const answer = consoleErrorSchema.safeParse(await response.json().catch(() => undefined));
          if (answer.success && answer.data.error.code === "not_found") return null;
          throw new Error("the console has no order journal at this address (HTTP 404)");
        }
        if (!response.ok) {
          const text = `the console answered ${await answerText(response)}`;
          throw response.status >= 500 ? new PassingConsoleError(text) : new Error(text);
        }
        const stored = storedVenueOrderSchema.parse(await response.json());
        if (hashExecutorRecord(stored.document).toLowerCase() !== stored.hash.toLowerCase()) {
          throw new Error(`the console's record of intent ${String(intentId)} no longer matches its hash`);
        }
        return stored.document;
      }),
    async put(record) {
      if (
        record.chainId !== options.deployment.chainId ||
        record.policy.toLowerCase() !== options.deployment.policy.toLowerCase()
      ) {
        throw new Error("this journal holds another contract's orders");
      }
      const signature = await options.sign(hashExecutorRecord(record));
      const body = JSON.stringify(putVenueOrderRequestSchema.parse({ document: record, signature }));
      await retrying(async () => {
        const response = await request(CONSOLE_EXECUTOR_ROUTES.order(record.intentId), {
          method: "PUT",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
        });
        if (response.status === 200 || response.status === 201) return;
        const answer = await consoleAnswer(response);
        const text = `the console did not store the order record: ${answer.text}`;
        // Only "not seen yet" and the console's own failures pass with time; any other refusal is final.
        throw response.status >= 500 || answer.code === "not_seen"
          ? new PassingConsoleError(text)
          : new Error(text);
      });
    },
  };
}

/**
 * Tells the console which venue fills orders. Returns null when it was stored, or why not (the console
 * is down or not following the contract yet): the caller tries again later.
 */
export async function announceVenue(
  options: Pick<ConsoleJournalOptions, "consoleUrl" | "sign" | "fetch" | "timeoutMs">,
  document: ExecutorVenue,
): Promise<string | null> {
  const base = options.consoleUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const signature = await options.sign(hashExecutorRecord(document));
  const body = putExecutorVenueRequestSchema.parse({ document, signature });
  let response: Response;
  try {
    response = await send(`${base}${CONSOLE_EXECUTOR_ROUTES.venue}`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch (error) {
    return `the console at ${base} did not answer (${error instanceof Error ? error.message : String(error)})`;
  }
  return response.ok ? null : `the console answered ${await answerText(response)}`;
}

/** A journal in memory, for tests: it keeps the same rules as the console's on revisions. */
export function memoryOrderJournal(): OrderJournal & {
  records: Map<number, VenueOrderRecord>;
  history: VenueOrderRecord[];
  /** While set, every call throws this, as if the console were down. */
  failing: string | null;
} {
  const records = new Map<number, VenueOrderRecord>();
  const history: VenueOrderRecord[] = [];
  const journal = {
    records,
    history,
    failing: null as string | null,
    get(intentId: number) {
      if (journal.failing) return Promise.reject(new Error(journal.failing));
      return Promise.resolve(records.get(intentId) ?? null);
    },
    put(record: VenueOrderRecord) {
      if (journal.failing) return Promise.reject(new Error(journal.failing));
      const previous = records.get(record.intentId);
      if (previous && record.revision <= previous.revision) {
        return Promise.reject(new Error(`stale revision ${String(record.revision)}`));
      }
      hashExecutorRecord(record);
      records.set(record.intentId, record);
      history.push(record);
      return Promise.resolve();
    },
  };
  return journal;
}
