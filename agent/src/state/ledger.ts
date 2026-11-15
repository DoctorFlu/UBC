import type { DecisionContext } from "@mandate/shared";

/**
 * Memory of recent proposals, kept by the server process.
 *
 * - Replay protection: Grok Bot is told to retry once after a transport error, and a lost
 *   response to `propose_trade` would otherwise create a second intent. An identical proposal
 *   inside `REPLAY_WINDOW_MS` returns the first one's result instead. A call still in flight is
 *   awaited, not repeated.
 * - Decision contexts: which document belongs to which intent, so `get_intent` can show it even
 *   when the contract cannot record the hash.
 * - Outbox: documents the console did not accept yet (it was down), retried on later proposals.
 */

export const REPLAY_WINDOW_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

interface ReplayEntry<T> {
  readonly at: number;
  readonly promise: Promise<T>;
}

export interface IntentRecord {
  contextHash: `0x${string}`;
  /** Whether the console has the document. */
  contextStored: boolean;
  /** Whether the hash is onchain with the intent. */
  contextHashRecorded: boolean;
  planId: string;
  reason: string;
}

export interface Replayed<T> {
  value: T;
  /** True when this is an earlier call's result. */
  replayed: boolean;
  /** When the call that produced `value` started. */
  firstAt: Date;
}

export class ProposalLedger {
  readonly #replays = new Map<string, ReplayEntry<unknown>>();
  readonly #intents = new Map<number, IntentRecord>();
  readonly #outbox = new Map<`0x${string}`, DecisionContext>();

  /**
   * Runs `work` once per `key` inside the replay window. `keep` decides whether a finished result
   * is replayed to later identical calls; results that are safe to retry are dropped instead.
   * A thrown error is never kept.
   */
  async once<T>(
    key: string,
    now: Date,
    work: () => Promise<T>,
    keep: (value: T) => boolean,
  ): Promise<Replayed<T>> {
    this.#prune(now.getTime());
    const existing = this.#replays.get(key) as ReplayEntry<T> | undefined;
    if (existing !== undefined) {
      return { value: await existing.promise, replayed: true, firstAt: new Date(existing.at) };
    }
    const promise = work();
    const entry: ReplayEntry<T> = { at: now.getTime(), promise };
    this.#replays.set(key, entry);
    try {
      const value = await promise;
      if (!keep(value) && this.#replays.get(key) === entry) this.#replays.delete(key);
      return { value, replayed: false, firstAt: now };
    } catch (error) {
      if (this.#replays.get(key) === entry) this.#replays.delete(key);
      throw error;
    }
  }

  remember(intentId: number, record: IntentRecord): void {
    this.#intents.set(intentId, record);
    for (const id of this.#intents.keys()) {
      if (this.#intents.size <= MAX_ENTRIES) break;
      this.#intents.delete(id);
    }
  }

  lookup(intentId: number): IntentRecord | undefined {
    return this.#intents.get(intentId);
  }

  /** Keeps a document the console has not accepted yet. */
  queueContext(hash: `0x${string}`, document: DecisionContext): void {
    this.#outbox.set(hash, document);
    for (const key of this.#outbox.keys()) {
      if (this.#outbox.size <= MAX_ENTRIES) break;
      this.#outbox.delete(key);
    }
  }

  pendingContexts(): [`0x${string}`, DecisionContext][] {
    return [...this.#outbox.entries()];
  }

  /** Marks a document as stored by the console, here and on every intent that uses it. */
  contextStored(hash: `0x${string}`): void {
    this.#outbox.delete(hash);
    for (const record of this.#intents.values()) {
      if (record.contextHash === hash) record.contextStored = true;
    }
  }

  /** Forgets a queued document the console will never accept. */
  dropContext(hash: `0x${string}`): void {
    this.#outbox.delete(hash);
  }

  #prune(nowMs: number): void {
    for (const [key, entry] of this.#replays) {
      if (nowMs - entry.at > REPLAY_WINDOW_MS) this.#replays.delete(key);
    }
  }
}
