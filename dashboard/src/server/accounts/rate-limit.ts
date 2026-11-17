import "server-only";

/**
 * In-memory token buckets: each key starts with `capacity` tokens and regains `refillPerSecond` a second.
 * One console process, one set of buckets (docs/accounts.md says what a fleet would use instead).
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Takes one token: 0 when allowed, otherwise the whole seconds until one is available. */
  take(key: string): number {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * this.refillPerSecond,
    );
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.prune(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerSecond);
  }

  /** Forgets full buckets, so a stream of new keys cannot grow the map without bound. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * this.refillPerSecond;
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** One limit: a bucket per client and one shared by everyone, so neither one client nor many can flood it. */
export class RateLimit {
  private readonly perClient: TokenBuckets;
  private readonly total: TokenBuckets;

  constructor(
    perClient: { capacity: number; refillPerSecond: number },
    total: { capacity: number; refillPerSecond: number },
    now?: () => number,
  ) {
    this.perClient = new TokenBuckets(perClient.capacity, perClient.refillPerSecond, now);
    this.total = new TokenBuckets(total.capacity, total.refillPerSecond, now);
  }

  /** 0 when allowed, otherwise the seconds to wait. */
  take(client: string): number {
    return Math.max(this.perClient.take(client), this.total.take("*"));
  }
}

/** Every rate limit the console applies (docs/accounts.md). */
export interface RateLimits {
  /** Passkey ceremonies: sign-in, sign-up, claim, recovery and adding a passkey. */
  ceremonies: RateLimit;
  /** Checks of a typed code: invite, claim and recovery codes. */
  codes: RateLimit;
  /** Token lookups that found no live token (the MCP server's checks). */
  failedTokens: RateLimit;
  /** Tokens a member creates. */
  tokenCreation: RateLimit;
  /** Passkey prompts for owner actions (#95): enough to approve a queue one by one. */
  stepUps: RateLimit;
  /** Mandates a member creates; the workspace's cap bounds the total, this the pace. */
  mandateCreation: RateLimit;
}

export function defaultRateLimits(now?: () => number): RateLimits {
  return {
    ceremonies: new RateLimit(
      { capacity: 20, refillPerSecond: 1 / 6 },
      { capacity: 300, refillPerSecond: 5 },
      now,
    ),
    codes: new RateLimit(
      { capacity: 10, refillPerSecond: 1 / 30 },
      { capacity: 60, refillPerSecond: 1 },
      now,
    ),
    failedTokens: new RateLimit(
      { capacity: 30, refillPerSecond: 0.5 },
      { capacity: 60, refillPerSecond: 1 },
      now,
    ),
    tokenCreation: new RateLimit(
      { capacity: 10, refillPerSecond: 1 / 60 },
      { capacity: 100, refillPerSecond: 1 },
      now,
    ),
    stepUps: new RateLimit(
      { capacity: 30, refillPerSecond: 1 / 2 },
      { capacity: 300, refillPerSecond: 5 },
      now,
    ),
    mandateCreation: new RateLimit(
      { capacity: 5, refillPerSecond: 1 / 120 },
      { capacity: 50, refillPerSecond: 1 / 10 },
      now,
    ),
  };
}

/** Who a request comes from (docs/accounts.md, "Rate limits"): one rule for the console and the MCP server. */
export { clientKey } from "@mandate/shared/node";
