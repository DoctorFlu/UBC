/**
 * In-memory token buckets keyed by caller. Each key starts with `capacity` tokens and regains
 * `refillPerSecond` tokens per second up to `capacity`. One process, one bucket set: enough for a
 * single server instance.
 */
export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: { capacity: number; refillPerSecond: number; now?: () => number }) {
    if (options.capacity < 1 || options.refillPerSecond <= 0) throw new Error("Invalid rate limit settings");
    this.#capacity = options.capacity;
    this.#refillPerSecond = options.refillPerSecond;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Takes one token for `key`. Returns 0 when allowed, otherwise the seconds until a token is available. */
  take(key: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsedSeconds * this.#refillPerSecond);
    bucket.updatedAt = now;
    this.#buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.#refillPerSecond);
  }
}
