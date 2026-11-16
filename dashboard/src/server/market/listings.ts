import "server-only";

import { type CategoryId, type MarketListing, isMarketSymbol } from "@mandate/shared";

import type { ListingStore } from "../store/listings";

/**
 * The mandate category of the Gemini event that lists `symbol`, or null when Gemini lists no such market.
 * Throws when Gemini cannot answer (down, slow, rate limited): "not listed" and "could not check" differ.
 */
export type ListingLookup = (symbol: string) => Promise<CategoryId | null>;

export interface MarketListingsOptions {
  lookup: ListingLookup;
  store: ListingStore;
  /** Called after each new verdict is stored, so the console can push a fresh snapshot. */
  onChange: () => void;
  logger?: { warn: (message: string) => void };
  now?: () => number;
  /** How long to wait after Gemini could not answer before asking again. */
  retryMs?: number;
}

const DEFAULT_RETRY_MS = 30_000;

/**
 * Checks each intent's market against Gemini's listing, the way the executor does before it trades, so the
 * console can flag what the executor will refuse: a market Gemini does not list, or one it lists under
 * another category than the intent's.
 *
 * Nothing waits on Gemini: `listings` returns the verdicts already stored and queues the rest, which one
 * background worker checks one at a time. A verdict is stored the first time Gemini gives one and never
 * asked again, so a market that has since settled keeps the verdict it had when the intent was seen, and a
 * page costs no Gemini request at all. When Gemini cannot answer, the worker waits `retryMs` and tries again;
 * meanwhile those intents show no listing flag rather than a wrong one.
 */
export class MarketListings {
  private readonly pending = new Set<string>();
  private readonly known = new Map<string, MarketListing>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private working = false;
  private stopped = false;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failing = false;

  constructor(private readonly options: MarketListingsOptions) {
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** The stored verdicts for `symbols` (Gemini symbols only); the others are checked in the background. */
  listings(symbols: Iterable<string>): Map<string, MarketListing> {
    const wanted = [...new Set(symbols)].filter(isMarketSymbol);
    const unread = wanted.filter((symbol) => !this.known.has(symbol));
    if (unread.length > 0) {
      for (const [symbol, listing] of this.options.store.get(unread)) this.known.set(symbol, listing);
    }
    const found = new Map<string, MarketListing>();
    for (const symbol of wanted) {
      const listing = this.known.get(symbol);
      if (listing) found.set(symbol, listing);
      else this.pending.add(symbol);
    }
    this.kick();
    return found;
  }

  /** Stops the worker after the check in flight; nothing more is asked. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Resolves once every queued market has a verdict or Gemini could not answer. For tests. */
  async settled(): Promise<void> {
    while (this.working) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private kick(): void {
    if (this.working || this.stopped || this.pending.size === 0 || this.retryTimer) return;
    const wait = this.retryAt - this.now();
    if (wait > 0) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.kick();
      }, wait);
      this.retryTimer.unref();
      return;
    }
    this.working = true;
    void this.drain().finally(() => {
      this.working = false;
      if (!this.stopped && this.pending.size > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    // A Set iterates over what is added while it runs, so markets queued meanwhile are checked too.
    for (const symbol of this.pending) {
      if (this.stopped) return;
      let category: CategoryId | null;
      try {
        category = await this.options.lookup(symbol);
      } catch (error) {
        this.retryAt = this.now() + this.retryMs;
        if (!this.failing) {
          this.failing = true;
          this.options.logger?.warn(
            `can't check markets against Gemini (${errorMessage(error)}); trying again in ${String(Math.round(this.retryMs / 1000))} s`,
          );
        }
        return;
      }
      this.failing = false;
      const checkedAt = new Date(this.now()).toISOString();
      const listing: MarketListing =
        category === null ? { listed: false, checkedAt } : { listed: true, category, checkedAt };
      this.known.set(symbol, this.options.store.save(symbol, listing));
      this.pending.delete(symbol);
      this.options.onChange();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
