/**
 * Token bucket. Gemini allows 120 public requests per minute per IP and queues a burst of five,
 * so the defaults (burst 5, refill 100 per minute) stay clearly under the limit even when the
 * bucket starts full: at most 5 + 100 = 105 requests in any 60-second window.
 */
import { raceAbort } from "@mandate/shared";

export interface TokenBucketOptions {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  /** Waiters are served in arrival order by chaining on this promise. */
  private queue: Promise<void> = Promise.resolve();
  private readonly options: TokenBucketOptions;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerMinute > 0)) {
      throw new RangeError("TokenBucket needs capacity >= 1 and refillPerMinute > 0");
    }
    this.options = options;
    this.tokens = options.capacity;
    this.updatedAt = options.now();
  }

  /**
   * Resolves once a token has been taken. When `signal` aborts first, rejects with its reason at
   * once and takes no token: the waiters behind it move up.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    const turn = this.queue.then(() => this.take(signal));
    this.queue = turn.catch(() => undefined);
    return raceAbort(turn, signal);
  }

  private async take(signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      // A waiter that gave up while queued or sleeping leaves its token to the next one.
      if (signal?.aborted) return;
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const msPerToken = 60_000 / this.options.refillPerMinute;
      await this.options.sleep(Math.ceil((1 - this.tokens) * msPerToken));
    }
  }

  private refill(): void {
    const now = this.options.now();
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = now;
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (elapsed * this.options.refillPerMinute) / 60_000,
    );
  }
}
