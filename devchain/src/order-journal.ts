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
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

async function answerText(response: Response): Promise<string> {
  const parsed = consoleErrorSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success
    ? `${parsed.data.error.code}: ${parsed.data.error.message}`
    : `HTTP ${String(response.status)}`;
}

export function consoleOrderJournal(options: ConsoleJournalOptions): OrderJournal {
  const base = options.consoleUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await send(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(
        `the console at ${base} did not answer (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
  };
  return {
    async get(intentId) {
      const response = await request(CONSOLE_EXECUTOR_ROUTES.order(intentId), {
        headers: { accept: "application/json" },
      });
      // Only the console's own "no record" counts as none: any other 404 (a proxy, an older console
      // without this route) is an outage, or a restart would send an order that may already exist.
      if (response.status === 404) {
        const answer = consoleErrorSchema.safeParse(await response.json().catch(() => undefined));
        if (answer.success && answer.data.error.code === "not_found") return null;
        throw new Error("the console has no order journal at this address (HTTP 404)");
      }
      if (!response.ok) throw new Error(`the console answered ${await answerText(response)}`);
      const stored = storedVenueOrderSchema.parse(await response.json());
      if (hashExecutorRecord(stored.document).toLowerCase() !== stored.hash.toLowerCase()) {
        throw new Error(`the console's record of intent ${String(intentId)} no longer matches its hash`);
      }
      return stored.document;
    },
    async put(record) {
      const signature = await options.sign(hashExecutorRecord(record));
      const body = putVenueOrderRequestSchema.parse({ document: record, signature });
      const response = await request(CONSOLE_EXECUTOR_ROUTES.order(record.intentId), {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`the console did not store the order record: ${await answerText(response)}`);
      }
    },
  };
}

/**
 * Tells the console which venue fills orders. Returns null when it was stored, or why not (the console
 * is down or not following the contract yet): the caller tries again later.
 */
export async function announceVenue(
  options: ConsoleJournalOptions,
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
