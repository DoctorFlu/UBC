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
 * - Link outbox: intent-to-context links the console did not take yet, retried on later proposals
 *   and when a proposal is replayed.
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
  /**
   * Whether the console links this intent to its document. False while the link waits in the outbox
   * or after the console refused it; null when no console is configured.
   */
  contextLinked: boolean | null;
  planId: string;
  reason: string;
}

/** What the console needs to link an intent to its decision context. */
export interface ContextLink {
  hash: `0x${string}`;
  /** The transaction that proposed the intent. */
  txHash: `0x${string}`;
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
  readonly #links = new Map<number, ContextLink>();

  /**
   * Runs `work` once per `key` inside the replay window. `keep` decides whether a finished result
   * is replayed to later identical calls; results that are safe to retry are dropped instead.
   * A thrown error is never kept. `whileWaiting` gets the wait for an identical call that is still
   * running and returns the wait to use, for example one that gives up at the caller's deadline; the
   * running call goes on either way.
   */
  async once<T>(
    key: string,
    now: Date,
    work: () => Promise<T>,
    keep: (value: T) => boolean,
    options: { whileWaiting?: (wait: Promise<T>) => Promise<T> } = {},
  ): Promise<Replayed<T>> {
    this.#prune(now.getTime());
    const existing = this.#replays.get(key) as ReplayEntry<T> | undefined;
    if (existing !== undefined) {
      const value = await (options.whileWaiting === undefined
        ? existing.promise
        : options.whileWaiting(existing.promise));
      return { value, replayed: true, firstAt: new Date(existing.at) };
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

  /** Keeps a link the console has not taken yet. */
  queueLink(intentId: number, link: ContextLink): void {
    this.#links.set(intentId, link);
    for (const key of this.#links.keys()) {
      if (this.#links.size <= MAX_ENTRIES) break;
      this.#links.delete(key);
    }
  }

  /** The queued link of one intent, if it still waits for the console. */
  pendingLink(intentId: number): ContextLink | undefined {
    return this.#links.get(intentId);
  }

  pendingLinks(): [number, ContextLink][] {
    return [...this.#links.entries()];
  }

  /**
   * Records the console's final answer for a queued link: linked, or refused for good (a conflict).
   * Either way the link leaves the outbox.
   */
  settleLink(intentId: number, linked: boolean): void {
    this.#links.delete(intentId);
    const record = this.#intents.get(intentId);
    if (record !== undefined) record.contextLinked = linked;
  }

  #prune(nowMs: number): void {
    for (const [key, entry] of this.#replays) {
      if (nowMs - entry.at > REPLAY_WINDOW_MS) this.#replays.delete(key);
    }
  }
}
