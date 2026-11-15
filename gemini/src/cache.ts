/**
 * Small in-memory TTL cache that also shares in-flight requests, so ten callers asking for the
 * same events page at once cost one request. Failed loads are never cached.
 */
export class TtlCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(now: () => number, maxEntries = 500) {
    this.now = now;
    this.maxEntries = maxEntries;
  }

  getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (ttlMs <= 0) return load();
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) return hit.value as Promise<T>;
    const value = load();
    // Expiry counts from when the load settles, so a slow request still gets its full TTL.
    const entry = { expiresAt: Number.POSITIVE_INFINITY, value: value as Promise<unknown> };
    this.entries.set(key, entry);
    this.evictIfFull();
    value.then(
      () => {
        entry.expiresAt = this.now() + ttlMs;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return value;
  }

  clear(): void {
    this.entries.clear();
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
