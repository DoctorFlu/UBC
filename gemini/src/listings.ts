/**
 * Checking intents' markets against Gemini's listing, paced so that a reader (the console) can never spend
 * the Gemini rate limit its owner's own views need, whatever the chain says.
 *
 * The markets come from the chain, and anyone holding the agent key can write a new one with every intent:
 * a stream of distinct, well-formed symbols that each cost fresh `getEvent` calls. The checker therefore
 * has a request budget of its own, well inside the client's, checks the intents the owner is looking at
 * first, and holds no more work than the latest list of markets it was given.
 */
import { type CategoryId, type MarketListing, isMarketSymbol } from "@mandate/shared";

import { eventTickerCandidates, MAX_RESOLVE_ATTEMPTS } from "./instruments";

/** Gemini's answer for one market: its mandate category, or null when Gemini lists no such market. */
export interface ListingAnswer {
  category: CategoryId | null;
  /**
   * Requests the lookup sent to Gemini, retries included (an event the client had cached costs none).
   * Left out, the lookup is charged its worst case.
   */
  requests?: number;
}

/** Throws when Gemini cannot answer (down, slow, rate limited): "not listed" and "could not check" differ. */
export type ListingLookup = (symbol: string) => Promise<ListingAnswer>;

/** Where verdicts are kept. The first verdict for a symbol wins; `save` returns the one stored. */
export interface ListingStore {
  get(symbols: readonly string[]): Map<string, MarketListing>;
  save(symbol: string, listing: MarketListing): MarketListing;
}

/**
 * The checker's own share of Gemini's rate limit. The client's bucket (burst 5, 100 a minute: at most 105
 * requests in any 60 s, under Gemini's public 120) also serves the owner's live ladder and previews. The
 * checker may send at most `burst + perMinute` = 24 requests in any 60 s, and 12 a minute sustained: under
 * a quarter of the client's budget even when every lookup misses the cache and every request is retried,
 * which a flood of invented symbols can force. The owner's views keep at least 81 requests a minute.
 *
 * The burst covers the costliest lookup (4 candidate tickers, each tried twice by a client that retries
 * once) with room for a few real markets beside it, so the markets of a new intent or two are checked at
 * once: a symbol of a real event costs a request or two, and nothing when the client has just read its
 * event. A flood of invented symbols is checked at one every 40 s.
 */
export const LISTING_REQUEST_BUDGET = { burst: 12, perMinute: 12 } as const;

/** How long to wait after Gemini could not answer before asking again. */
export const LISTING_RETRY_MS = 30_000;

/**
 * The most requests one lookup can send: one `getEvent` per candidate event ticker, each up to
 * `attemptsPerRequest` times.
 */
export function worstCaseRequests(symbol: string, attemptsPerRequest: number): number {
  return Math.max(1, eventTickerCandidates(symbol).length) * attemptsPerRequest;
}

/** The fields of an intent that decide when its market is checked. */
export interface ListingCandidate {
  id: number;
  status: string;
  market: string | null;
}

/**
 * The Gemini symbols of `intents` in the order to check them: those waiting for the owner's approval
 * first (the owner needs the verdict before pressing Approve), then the rest newest first (the ones on
 * screen). Each symbol once, at its most urgent place. Text that is not a symbol is never looked up.
 */
export function listingOrder(intents: readonly ListingCandidate[]): string[] {
  const urgency = (intent: ListingCandidate) => (intent.status === "needs_approval" ? 0 : 1);
  const ordered = [...intents].sort((a, b) => urgency(a) - urgency(b) || b.id - a.id);
  const symbols = new Set<string>();
  for (const intent of ordered) {
    if (intent.market !== null && isMarketSymbol(intent.market)) symbols.add(intent.market);
  }
  return [...symbols];
}

export interface ListingCheckerOptions {
  lookup: ListingLookup;
  store: ListingStore;
  /** The most times the lookup's client sends one request: 1 plus its retries. */
  attemptsPerRequest: number;
  /** Called after each new verdict is stored, so the reader can show it. */
  onChange?: () => void;
  logger?: { warn: (message: string) => void };
  now?: () => number;
  /** Waits; tests pass one driven by a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  budget?: { burst: number; perMinute: number };
  retryMs?: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // A waiting checker must not keep the process alive.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Checks markets against Gemini's listing in the background, one at a time, within its request budget.
 *
 * Nothing waits on Gemini: `listings` returns the stored verdicts at once and makes the markets without one
 * the checker's queue, in the order given (see `listingOrder`). Each call replaces the queue, so it never
 * holds more than the caller's latest list, and the market the owner needs now goes ahead of a flood. A
 * verdict is stored the first time Gemini gives one and never asked for again. When Gemini cannot answer,
 * the checker tries again after `retryMs`; meanwhile those markets have no verdict, never a wrong one.
 *
 * Pacing is a token bucket counted in requests. Each lookup reserves its worst case before it starts, so
 * the budget holds whatever Gemini does, and gets back what it did not send (an event the client had
 * cached, a candidate it did not need to try). The reservation counts against the bucket until then.
 */
export class ListingChecker {
  private queue: string[] = [];
  private readonly known = new Map<string, MarketListing>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget: { burst: number; perMinute: number };
  private readonly retryMs: number;
  /** Requests the checker may send now. */
  private tokens: number;
  private tokensAt: number;
  /** Requests reserved by the lookup in flight; tokens + reserved never exceeds the burst. */
  private reserved = 0;
  private retryAt = 0;
  private failing = false;
  private checking: string | null = null;
  private running: Promise<void> | null = null;
  private waiting = false;
  private stopped = false;

  constructor(private readonly options: ListingCheckerOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.budget = options.budget ?? LISTING_REQUEST_BUDGET;
    this.retryMs = options.retryMs ?? LISTING_RETRY_MS;
    const costliest = MAX_RESOLVE_ATTEMPTS * options.attemptsPerRequest;
    if (!(options.attemptsPerRequest >= 1) || !(this.budget.perMinute > 0) || this.budget.burst < costliest) {
      throw new RangeError(`the listing budget needs a burst of at least ${costliest.toString()} requests`);
    }
    this.tokens = this.budget.burst;
    this.tokensAt = this.now();
  }

  /**
   * The stored verdicts for `symbols` (Gemini symbols only). The rest become the queue, in this order,
   * replacing the previous one, and are checked in the background.
   */
  listings(symbols: readonly string[]): Map<string, MarketListing> {
    const wanted = [...new Set(symbols)].filter(isMarketSymbol);
    const unread = wanted.filter((symbol) => !this.known.has(symbol));
    if (unread.length > 0) {
      for (const [symbol, listing] of this.options.store.get(unread)) this.known.set(symbol, listing);
    }
    const found = new Map<string, MarketListing>();
    const queue: string[] = [];
    for (const symbol of wanted) {
      const listing = this.known.get(symbol);
      if (listing) found.set(symbol, listing);
      else if (symbol !== this.checking) queue.push(symbol);
    }
    if (this.stopped) return found;
    this.queue = queue;
    if (queue.length > 0 && !this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return found;
  }

  /** Markets waiting to be checked, in order. */
  get queued(): readonly string[] {
    return this.queue;
  }

  /** Stops after the check in flight; nothing more is asked. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  /**
   * Resolves once the checker has nothing to do now: its queue is empty, it is waiting for its budget or
   * for Gemini to come back, or it stopped. For tests.
   */
  async settled(): Promise<void> {
    while (this.running && !this.waiting) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.tokensAt);
    this.tokensAt = now;
    const room = this.budget.burst - this.reserved;
    this.tokens = Math.min(room, this.tokens + (elapsed * this.budget.perMinute) / 60_000);
  }

  private async wait(ms: number): Promise<void> {
    this.waiting = true;
    try {
      await this.sleep(ms);
    } finally {
      this.waiting = false;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const symbol = this.queue[0];
      if (symbol === undefined) return;
      const cost = worstCaseRequests(symbol, this.options.attemptsPerRequest);
      this.refill();
      const forBudget = Math.ceil(((cost - this.tokens) * 60_000) / this.budget.perMinute);
      const wait = Math.max(this.retryAt - this.now(), forBudget, 0);
      if (wait > 0) {
        // The queue may change meanwhile; whatever is first then goes next.
        await this.wait(wait);
        continue;
      }
      this.queue.shift();
      this.checking = symbol;
      this.tokens -= cost;
      this.reserved = cost;
      let answer: ListingAnswer | null = null;
      let failure: unknown = null;
      try {
        answer = await this.options.lookup(symbol);
      } catch (error) {
        failure = error;
      }
      this.refill();
      this.reserved = 0;
      this.checking = null;
      if (answer === null) {
        // What a failed lookup sent is unknown: it keeps its whole reservation.
        this.retryAt = this.now() + this.retryMs;
        if (!this.queue.includes(symbol)) this.queue.unshift(symbol);
        if (!this.failing) {
          this.failing = true;
          this.options.logger?.warn(
            `can't check markets against Gemini (${failure instanceof Error ? failure.message : String(failure)}); trying again in ${Math.round(this.retryMs / 1000).toString()} s`,
          );
        }
        continue;
      }
      const sent = Math.min(cost, Math.max(0, answer.requests ?? cost));
      this.tokens += cost - sent;
      this.failing = false;
      const checkedAt = new Date(this.now()).toISOString();
      const listing: MarketListing =
        answer.category === null
          ? { listed: false, checkedAt }
          : { listed: true, category: answer.category, checkedAt };
      this.known.set(symbol, this.options.store.save(symbol, listing));
      this.queue = this.queue.filter((queued) => queued !== symbol);
      this.options.onChange?.();
    }
  }
}
