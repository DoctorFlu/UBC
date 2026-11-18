import "server-only";

import {
  DEFAULT_BASE_URL,
  type FetchLike,
  type GeminiClient,
  type Ladder,
  type ListingAnswer,
  createMarketDataClient,
  createProductionClient,
  eventPath,
  eventTickerCandidates,
  findInstrument,
  isGeminiError,
  ladderRungs,
  marketDataSource,
  type MarketDataSource,
} from "@mandate/gemini";
import { type CategoryId, categoryFromGemini } from "@mandate/shared";

import type { LadderQuotes, MarketDataError } from "@/lib/hedge/types";

/**
 * Live ladder quotes from Gemini's public, read-only endpoints, for the hedge view. The browser never
 * calls Gemini: it asks the console, which asks Gemini through this class and keeps every answer for a
 * few seconds, so any number of open pages cost one request per ladder per window. A Gemini that is
 * down or slow becomes an error the view shows next to the agent's stored plan, never a broken page.
 */
export interface MarketQuotesOptions {
  /** Where listings and books are read: the venue's exchange. Default production. */
  baseUrl?: string;
  /**
   * Gemini production's public API: where spot is read on every venue (the ladders settle on its index),
   * and where the strikes of the simulated venue's earlier fills are listed. Default `baseUrl`.
   */
  productionBaseUrl?: string;
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

/** A strike by instrument symbol. */
export interface StrikeRef {
  instrumentSymbol: string;
  strikeCents: number;
}

/**
 * `elsewhere`: the strikes production lists on the same event that the venue's ladder lacks, for cover of
 * positions the simulated venue filled there (`symbolsMissingFromLadder`); empty when the venue is
 * production, null when production could not be read. Absent counts as empty.
 */
export type LadderLookup =
  | { ok: true; ladder: Ladder; elsewhere?: readonly StrikeRef[] | null }
  | { ok: false; error: MarketDataError };

interface Entry {
  at: number;
  ttl: number;
  result: Promise<LadderLookup>;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_ERROR_TTL_MS = 5_000;
/** The route only asks for known assets and stored plans' events, so a handful of keys is the norm. */
const DEFAULT_MAX_ENTRIES = 32;
/** A page waits on these requests: fail fast and let the next refresh try again. */
const MAX_RETRIES = 1;

export class MarketQuotes {
  readonly baseUrl: string;
  readonly productionBaseUrl: string;
  private readonly client: GeminiClient;
  /** Production's client when the venue is another exchange; null when the venue is production. */
  private readonly production: GeminiClient | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly maxEntries: number;
  /** Insertion order is age order: a refreshed key is deleted and set again. */
  private readonly cache = new Map<string, Entry>();
  /** The event paths each listing lookup in flight may request, and how many requests went to them. */
  private readonly lookups = new Set<{ paths: ReadonlySet<string>; sent: number }>();
  /** The most times the client sends one request. */
  static readonly ATTEMPTS_PER_REQUEST = MAX_RETRIES + 1;

  constructor(options: MarketQuotesOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.productionBaseUrl = (options.productionBaseUrl ?? this.baseUrl).replace(/\/+$/, "");
    const shared = {
      now: this.now,
      maxRetries: MAX_RETRIES,
      timeoutMs: 6_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    };
    this.client = createMarketDataClient(
      { baseUrl: this.baseUrl, productionBaseUrl: this.productionBaseUrl },
      {
        ...shared,
        onRequest: (path) => {
          for (const lookup of this.lookups) if (lookup.paths.has(path)) lookup.sent += 1;
        },
      },
    );
    this.production =
      this.productionBaseUrl === this.baseUrl
        ? null
        : createProductionClient({ productionBaseUrl: this.productionBaseUrl }, shared);
  }

  /**
   * The mandate category of the Gemini event that lists `instrumentSymbol`, or null when Gemini lists no
   * such market, with the requests the lookup sent. Throws when Gemini cannot answer. Uses the client's
   * own cache of event reads, which the hedge view shares: a request it sends for one of these events
   * meanwhile is counted too, so the count is never low.
   */
  async marketCategory(instrumentSymbol: string): Promise<ListingAnswer> {
    const candidates = eventTickerCandidates(instrumentSymbol);
    const lookup = { paths: new Set(candidates.map(eventPath)), sent: 0 };
    this.lookups.add(lookup);
    try {
      const found = await findInstrument(
        (ticker) => this.client.getEvent(ticker),
        instrumentSymbol,
        candidates,
      );
      const category: CategoryId | null =
        found === null ? null : categoryFromGemini(found.event.category ?? "");
      return { category, requests: lookup.sent };
    } finally {
      this.lookups.delete(lookup);
    }
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
        async (ladder): Promise<LadderLookup> => ({
          ok: true,
          ladder,
          elsewhere: await this.elsewhere(ladder),
        }),
        (error: unknown): LadderLookup => {
          entry.ttl = this.errorTtlMs;
          return { ok: false, error: describeFailure(error) };
        },
      );
    this.remember(key, entry, time);
    return entry.result;
  }

  /** The strikes production lists on this ladder's event that the ladder lacks, or null when unreadable. */
  private async elsewhere(ladder: Ladder): Promise<StrikeRef[] | null> {
    if (this.production === null) return [];
    const listed = new Set(ladder.rungs.map((rung) => rung.instrumentSymbol));
    try {
      const event = await this.production.getEvent(ladder.eventTicker);
      return ladderRungs(event)
        .filter((rung) => !listed.has(rung.instrumentSymbol))
        .map((rung) => ({ instrumentSymbol: rung.instrumentSymbol, strikeCents: rung.strikeCents }));
    } catch {
      // Cover then counts what the venue lists, and is shown as unavailable only if a held position needs
      // a strike from production (`UnresolvedPositionError`): the ladder itself is still good.
      return null;
    }
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
      case "spot_unavailable":
        return {
          code: "unavailable",
          message:
            "Gemini's market data is unavailable: its BTC/USD spot market is not trading normally, so nothing is measured from it. The console tries again on the next refresh.",
        };
    }
  }
  return UNKNOWN;
}

/** The parts of a ladder the hedge view draws, highest strike first like the plan's rungs. */
export function ladderQuotes(ladder: Ladder, elsewhere: readonly StrikeRef[] | null = []): LadderQuotes {
  return {
    asset: ladder.asset,
    eventTicker: ladder.eventTicker,
    title: ladder.title,
    expiry: ladder.expiry,
    spotCents: ladder.spot.midCents,
    spotBasis: ladder.spot.basis ?? "mid",
    elsewhere: elsewhere === null ? null : [...elsewhere],
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

const SOURCE_KEY = Symbol.for("mandate.market-data");

/**
 * Which Gemini this console reads, from EXECUTOR_VENUE, GEMINI_ENV and GEMINI_API_URL (`marketDataSource`):
 * the executor's environment when it trades on Gemini, production otherwise. Read once per process; a
 * contradiction throws, naming the settings, and `/api/health` reports it.
 */
export function consoleMarketData(): MarketDataSource {
  const holder = globalThis as unknown as Record<typeof SOURCE_KEY, MarketDataSource | undefined>;
  let source = holder[SOURCE_KEY];
  if (!source) {
    source = marketDataSource(process.env);
    holder[SOURCE_KEY] = source;
    console.log(`[console] market data from Gemini's ${source.environment} (${source.settings})`);
  }
  return source;
}

const KEY = Symbol.for("mandate.market-quotes");
type Holder = Record<typeof KEY, MarketQuotes | undefined>;

/** The process-wide quotes source, from the console's market data source (`consoleMarketData`). */
export function getMarketQuotes(): MarketQuotes {
  const holder = globalThis as unknown as Holder;
  let quotes = holder[KEY];
  if (!quotes) {
    const source = consoleMarketData();
    quotes = new MarketQuotes({ baseUrl: source.baseUrl, productionBaseUrl: source.productionBaseUrl });
    holder[KEY] = quotes;
  }
  return quotes;
}
