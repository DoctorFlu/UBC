/**
 * The executor's order journal (issue #93): the record of the order placed for each intent, kept in the
 * console's executor API (`CONSOLE_EXECUTOR_ROUTES.order`), because the executor container has no disk
 * of its own. A real venue writes "placing" before it sends an order and refuses to send one when it
 * cannot write that first, so a restart or a retry always finds out about an earlier attempt.
 */
import {
  CONSOLE_EXECUTOR_ROUTES,
  consoleErrorSchema,
  executorVenueAnswerSchema,
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
 * Tells the console which venue fills orders. Returns what the console did with it (stored a new
 * announcement, or found this venue already in force), or why it did not take it (the console is down or
 * not following the contract yet, or reads another Gemini): the caller tries again later or stops.
 */
export async function announceVenue(
  options: Pick<ConsoleJournalOptions, "consoleUrl" | "sign" | "fetch" | "timeoutMs">,
  document: ExecutorVenue,
): Promise<VenueAnnouncementOutcome> {
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
    return {
      accepted: false,
      mismatch: false,
      message: `the console at ${base} did not answer (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (response.ok) {
    // A console from before the answer carried them leaves out `stored`, `seq` and `holdsFromBlock`.
    const answer = executorVenueAnswerSchema.safeParse(await response.json().catch(() => undefined));
    const data = answer.success ? answer.data : null;
    return {
      accepted: true,
      stored: data?.stored ?? response.status === 201,
      seq: data?.seq ?? null,
      holdsFromBlock: data?.holdsFromBlock ?? null,
    };
  }
  const answer = await consoleAnswer(response);
  return answer.code === "environment_mismatch"
    ? { accepted: false, mismatch: true, message: answer.text.replace(/^environment_mismatch: /, "") }
    : { accepted: false, mismatch: false, message: `the console answered ${answer.text}` };
}

/** What the console did with the executor's venue announcement. */
export type VenueAnnouncementOutcome = VenueAnnouncementAccepted | VenueAnnouncementProblem;

export interface VenueAnnouncementAccepted {
  accepted: true;
  /** True when the console stored a new announcement; false when this venue was already in force. */
  stored: boolean;
  /** The announcement in force now, 0 for the first; null from a console that does not say. */
  seq: number | null;
  /** The first block it holds from; null for one stored before blocks were recorded, or not said. */
  holdsFromBlock: number | null;
}

/** Why the console has not taken the executor's venue announcement. */
export interface VenueAnnouncementProblem {
  accepted: false;
  /**
   * True when the console reads another Gemini than the executor (409 `environment_mismatch`): settings
   * to fix, never resolved by trying again, so the executor stops. Otherwise the console is not up yet.
   */
  mismatch: boolean;
  message: string;
}

/** The line the executor logs once the console took its announcement. */
export function announcementAcceptedLine(policy: string, outcome: VenueAnnouncementAccepted): string {
  const which = outcome.seq === null ? "the announcement" : `announcement #${String(outcome.seq)}`;
  const from =
    outcome.holdsFromBlock === null
      ? outcome.seq === null
        ? ""
        : ", holding from the contract's first block"
      : `, holding from block ${String(outcome.holdsFromBlock)}`;
  return outcome.stored
    ? `[executor] The console stored the venue of ${policy} as ${which}${from}.`
    : `[executor] The console already has this venue in force for ${policy} (${which}${from}): nothing added.`;
}

export interface AnnounceUntilAcceptedOptions {
  /** One attempt: `announceVenue` with the executor's console and key. */
  announce: () => Promise<VenueAnnouncementOutcome>;
  policy: string;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** The first wait; each next one doubles, up to `maxWaitMs`. */
  firstWaitMs?: number;
  maxWaitMs?: number;
}

/**
 * Announces until the console takes it, logging every failed attempt with the wait before the next, and
 * once what the console did. The console may start after the executor, so it tries again with growing
 * waits; it asks nothing of Gemini. Resolves with the accepted outcome; rejects with the console's words
 * when the console reads another Gemini (`environment_mismatch`), which no retry resolves.
 */
export async function announceUntilAccepted(
  options: AnnounceUntilAcceptedOptions,
): Promise<VenueAnnouncementAccepted> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const firstWaitMs = options.firstWaitMs ?? 5_000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await options.announce();
    if (outcome.accepted) {
      options.log(announcementAcceptedLine(options.policy, outcome));
      return outcome;
    }
    if (outcome.mismatch) throw new Error(`The console refused this executor: ${outcome.message}`);
    const waitMs = Math.min(firstWaitMs * 2 ** (attempt - 1), maxWaitMs);
    options.log(
      `[executor] Could not tell the console the venue of ${options.policy} yet (${outcome.message}); ` +
        `attempt ${String(attempt)}, trying again in ${String(Math.round(waitMs / 1_000))} s.`,
    );
    await sleep(waitMs);
  }
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
