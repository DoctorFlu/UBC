import "server-only";

import {
  DEFAULT_BASE_URL,
  type FetchLike,
  type GeminiClient,
  type Ladder,
  createGeminiClient,
  isGeminiError,
} from "@mandate/gemini";

import type { LadderQuotes, MarketDataError } from "@/lib/hedge/types";

/**
 * Live ladder quotes from Gemini's public, read-only endpoints, for the hedge view. The browser never
 * calls Gemini: it asks the console, which asks Gemini through this class and keeps every answer for a
 * few seconds, so any number of open pages cost one request per ladder per window. A Gemini that is
 * down or slow becomes an error the view shows next to the agent's stored plan, never a broken page.
 */
export interface MarketQuotesOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Waits between retries; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a ladder answer is reused. */
  ttlMs?: number;
  /** How long a failure is reused before Gemini is asked again. */
  errorTtlMs?: number;
  /** Most ladders kept at once; the oldest goes first. */
  maxEntries?: number;
}

export type LadderLookup = { ok: true; ladder: Ladder } | { ok: false; error: MarketDataError };

interface Entry {
  at: number;
  ttl: number;
  result: Promise<LadderLookup>;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_ERROR_TTL_MS = 5_000;
/** The route only asks for known assets and stored plans' events, so a handful of keys is the norm. */
const DEFAULT_MAX_ENTRIES = 32;

export class MarketQuotes {
  readonly baseUrl: string;
  private readonly client: GeminiClient;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly maxEntries: number;
  /** Insertion order is age order: a refreshed key is deleted and set again. */
  private readonly cache = new Map<string, Entry>();

  constructor(options: MarketQuotesOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.client = createGeminiClient({
      baseUrl: this.baseUrl,
      now: this.now,
      // A page waits on this: fail fast and let the next refresh try again.
      maxRetries: 1,
      timeoutMs: 6_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  /**
   * The ladder of `eventTicker`, or the soonest weekly ladder of `asset` when no event is given.
   * Concurrent and repeated calls within the cache window share one answer.
   */
  ladder(asset: string, eventTicker: string | null): Promise<LadderLookup> {
    const key = `${asset}:${eventTicker ?? "weekly"}`;
    const time = this.now();
    const cached = this.cache.get(key);
    if (cached && time - cached.at < cached.ttl) return cached.result;

    const entry: Entry = {
      at: time,
      ttl: this.ttlMs,
      result: Promise.resolve({ ok: false, error: UNKNOWN }),
    };
    entry.result = this.client
      .getLadder({
        asset,
        ...(eventTicker === null ? { horizon: "weekly" as const } : { eventTicker }),
      })
      .then(
        (ladder): LadderLookup => ({ ok: true, ladder }),
        (error: unknown): LadderLookup => {
          entry.ttl = this.errorTtlMs;
          return { ok: false, error: describeFailure(error) };
        },
      );
    this.remember(key, entry, time);
    return entry.result;
  }

  /** How many ladders are cached; for tests. */
  get size(): number {
    return this.cache.size;
  }

  /** Stores an entry after dropping expired ones, then the oldest beyond the cap. */
  private remember(key: string, entry: Entry, time: number): void {
    this.cache.delete(key);
    for (const [cachedKey, cached] of this.cache) {
      if (time - cached.at >= cached.ttl) this.cache.delete(cachedKey);
    }
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, entry);
  }
}

const UNKNOWN: MarketDataError = { code: "unavailable", message: "Gemini's quotes are not available." };

/** One sentence for the owner, by failure kind. Never the raw message, which can carry internals. */
export function describeFailure(error: unknown): MarketDataError {
  if (isGeminiError(error)) {
    switch (error.code) {
      case "no_ladder":
      case "not_found":
        return {
          code: "no_ladder",
          message: "Gemini has no open ladder for this asset and expiry right now.",
        };
      case "rate_limited":
        return {
          code: "rate_limited",
          message: "Gemini is rate limiting the console. Quotes resume shortly.",
        };
      case "timeout":
      case "network":
      case "http":
        return {
          code: "unreachable",
          message: "Gemini's public API did not answer. The console tries again on the next refresh.",
        };
      case "invalid_response":
        return { code: "invalid_response", message: "Gemini answered with data the console could not read." };
      case "invalid_argument":
        return { code: "invalid_argument", message: "That asset or event is not one Gemini lists." };
    }
  }
  return UNKNOWN;
}

/** The parts of a ladder the hedge view draws, highest strike first like the plan's rungs. */
export function ladderQuotes(ladder: Ladder): LadderQuotes {
  return {
    asset: ladder.asset,
    eventTicker: ladder.eventTicker,
    title: ladder.title,
    expiry: ladder.expiry,
    spotCents: ladder.spot.midCents,
    fetchedAt: ladder.fetchedAt,
    rungs: [...ladder.rungs]
      .sort((a, b) => b.strikeCents - a.strikeCents)
      .map((rung) => ({
        instrumentSymbol: rung.instrumentSymbol,
        strikeCents: rung.strikeCents,
        label: rung.label,
        marketState: rung.marketState,
        noBuyCents: rung.noBuyCents,
        yesBidCents: rung.yesBidCents,
        yesAskCents: rung.yesAskCents,
      })),
  };
}

const KEY = Symbol.for("mandate.market-quotes");
type Holder = Record<typeof KEY, MarketQuotes | undefined>;

/** The process-wide quotes source, reading `GEMINI_API_URL` (default: Gemini's public API) once. */
export function getMarketQuotes(): MarketQuotes {
  const holder = globalThis as unknown as Holder;
  let quotes = holder[KEY];
  if (!quotes) {
    const baseUrl = process.env.GEMINI_API_URL?.trim();
    quotes = new MarketQuotes(baseUrl ? { baseUrl } : {});
    holder[KEY] = quotes;
  }
  return quotes;
}
