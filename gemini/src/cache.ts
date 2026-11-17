/**
 * Small in-memory TTL cache that also shares in-flight requests, so ten callers asking for the
 * same events page at once cost one request. Failed loads are never cached.
 *
 * A shared load belongs to everyone waiting for it. A caller whose signal aborts stops waiting at
 * once; the load itself is aborted only when no caller is left waiting for it, so one caller giving
 * up never fails another.
 */
interface Entry {
  expiresAt: number;
  value: Promise<unknown>;
  settled: boolean;
  /** Callers waiting with a signal. */
  waiters: number;
  /** A caller without a signal waits: the load always runs to its end. */
  pinned: boolean;
  controller: AbortController;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(now: () => number, maxEntries = 500) {
    this.now = now;
    this.maxEntries = maxEntries;
  }

  /**
   * The cached value for `key`, or the result of `load`, shared with every caller asking for the
   * same key meanwhile. `load` gets a signal that aborts when every caller has stopped waiting.
   */
  getOrLoad<T>(
    key: string,
    ttlMs: number,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    if (ttlMs <= 0) return load(signal ?? new AbortController().signal);
    const hit = this.entries.get(key);
    const entry = hit !== undefined && hit.expiresAt > this.now() ? hit : this.start(key, ttlMs, load);
    if (entry.settled) return entry.value as Promise<T>;
    return this.wait(key, entry, signal) as Promise<T>;
  }

  clear(): void {
    this.entries.clear();
  }

  private start<T>(key: string, ttlMs: number, load: (signal: AbortSignal) => Promise<T>): Entry {
    const controller = new AbortController();
    const value = load(controller.signal);
    // Expiry counts from when the load settles, so a slow request still gets its full TTL.
    const entry: Entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      value,
      settled: false,
      waiters: 0,
      pinned: false,
      controller,
    };
    this.entries.set(key, entry);
    this.evictIfFull();
    value.then(
      () => {
        entry.settled = true;
        entry.expiresAt = this.now() + ttlMs;
      },
      () => {
        entry.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry;
  }

  private wait(key: string, entry: Entry, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal === undefined) {
      entry.pinned = true;
      return entry.value;
    }
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        entry.waiters -= 1;
        if (!entry.settled && entry.waiters === 0 && !entry.pinned) {
          // Nobody waits for this load any more: stop it, and let the next caller start afresh.
          if (this.entries.get(key) === entry) this.entries.delete(key);
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason as Error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void entry.value.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  private evictIfFull(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Still full of live entries: drop the oldest insertions.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) return;
      this.entries.delete(key);
    }
  }
}
