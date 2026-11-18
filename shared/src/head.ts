/** The chain's latest block as the pollers use it. */
export interface ChainHead {
  number: bigint;
  /** Unix seconds. */
  timestamp: bigint;
}

/**
 * The latest block, read at most once per `maxAgeMs` however many pollers of one endpoint ask: callers
 * within that age get the block already read, and callers that ask while a read is under way share it.
 * A failed read is not kept, so the next caller reads again (through the endpoint's rate-limit gate).
 */
export class HeadCache {
  #last: { head: ChainHead; at: number } | null = null;
  #reading: Promise<ChainHead> | null = null;
  readonly #read: () => Promise<ChainHead>;
  readonly #now: () => number;

  constructor(read: () => Promise<ChainHead>, now: () => number = Date.now) {
    this.#read = read;
    this.#now = now;
  }

  /** The latest block, read no longer than `maxAgeMs` ago. */
  latest(maxAgeMs: number): Promise<ChainHead> {
    const last = this.#last;
    if (last && this.#now() - last.at < maxAgeMs) return Promise.resolve(last.head);
    if (this.#reading) return this.#reading;
    const reading = this.#read().then((head) => {
      // A node behind a load balancer can answer with an older block: never go back.
      const kept = this.#last && this.#last.head.number > head.number ? this.#last.head : head;
      this.#last = { head: kept, at: this.#now() };
      return kept;
    });
    this.#reading = reading.finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }
}

const caches = new Map<string, HeadCache>();

/**
 * The process's head cache for one endpoint and chain: the console's followers (one per contract) and the
 * executor's watchers (one per contract) share one head poll instead of one each. `read` is used only by
 * the first caller for a key.
 */
export function sharedHead(key: string, read: () => Promise<ChainHead>): HeadCache {
  let cache = caches.get(key);
  if (!cache) {
    cache = new HeadCache(read);
    caches.set(key, cache);
  }
  return cache;
}
