/**
 * Read-only client for Gemini's public prediction-market and spot endpoints. No API key, no
 * authenticated route, no order placement: every call here is a public GET.
 */
import { TtlCache } from "./cache";
import { GeminiError } from "./errors";
import { getJson, type FetchLike, type HttpOptions } from "./http";
import {
  buildLadder,
  depthFromBook,
  ladderRungs,
  listingFromEvent,
  normalizeBook,
  normalizeCandles,
  normalizeEvent,
  normalizeSettled,
  normalizeTicker,
  spotSymbol,
  summarizeEvent,
} from "./normalize";
import { TokenBucket } from "./rate-limiter";
import {
  candlesSchema,
  categoriesSchema,
  eventSchema,
  eventsResponseSchema,
  orderBookSchema,
  tickerSchema,
  type RawEvent,
} from "./schemas";
import type {
  Candle,
  CandleTimeFrame,
  EventSummary,
  Ladder,
  LadderKind,
  LadderListing,
  MarketEvent,
  OrderBook,
  RungDepth,
  SeriesKind,
  SettledEvent,
  SpotPrice,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.gemini.com";

/** The request path of `getEvent(eventTicker)`, as `onRequest` sees it. */
export function eventPath(eventTicker: string): string {
  return `/v1/prediction-markets/events/${encodeURIComponent(eventTicker)}`;
}
const PAGE_SIZE = 500;
const CRYPTO_CATEGORY = "Crypto";

export interface CacheTtls {
  /** Events list pages: large responses (hundreds of KB to tens of MB), so cached longest. */
  events: number;
  /** A single event, used for fresh ladder prices. */
  event: number;
  book: number;
  spot: number;
  settled: number;
  categories: number;
  /** Spot candles. A new hourly candle appears once an hour, so they are cached longest. */
  candles: number;
}

const DEFAULT_TTLS: CacheTtls = {
  events: 15_000,
  event: 3_000,
  book: 2_000,
  spot: 2_000,
  settled: 30_000,
  categories: 300_000,
  candles: 300_000,
};

export interface GeminiClientOptions {
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Clock in milliseconds. Drives the rate limiter, the cache and ladder selection. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Source of jitter in [0, 1). */
  random?: () => number;
  /** Per-attempt timeout, including reading the body. Default 15 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429, 5xx, timeouts and network errors. Default 3. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Token bucket settings. Defaults: burst 5, 100 per minute (Gemini's public limit is 120). */
  rateLimit?: { capacity?: number; refillPerMinute?: number };
  cacheTtlMs?: Partial<CacheTtls>;
  /** Called with the path of each request as it is sent, retries included (cached answers send none). */
  onRequest?: (path: string) => void;
}

export interface ListEventsOptions {
  /** Server-side category filter, e.g. "Crypto". Defaults to "Crypto" when `asset` or `kind` is set. */
  category?: string | readonly string[];
  /** Server-side status filter. Default "active". */
  status?: string | readonly string[];
  /** Crypto underlying, e.g. "BTC" (filtered client-side from the ticker). */
  asset?: string;
  /** Series kind (filtered client-side). */
  kind?: SeriesKind;
  /** Server-side title search. */
  search?: string;
  /** Safety cap on pages of 500. Default 10. */
  maxPages?: number;
}

export interface SettledOptions {
  category?: string | readonly string[];
  asset?: string;
  /** Default 50, max 500. */
  limit?: number;
}

/**
 * Which open rungs to fetch top-of-book depth for. Each rung costs one book request.
 * "below-spot" covers the strikes a protective hedge can use: those below spot plus the first
 * strike at or above it.
 */
export type DepthMode = "none" | "all" | "below-spot";

export interface GetLadderOptions {
  asset: string;
  /** Pick a specific event, e.g. "BTC2611202200". */
  eventTicker?: string;
  /** Pick the ladder that expires at exactly this instant. */
  expiry?: string | Date;
  /** Pick the soonest open ladder of this kind. */
  horizon?: LadderKind;
  /** Default "none". */
  depth?: DepthMode;
}

export interface GeminiClient {
  listEvents(options?: ListEventsOptions): Promise<EventSummary[]>;
  getEvent(eventTicker: string): Promise<MarketEvent>;
  getOrderBook(instrumentSymbol: string): Promise<OrderBook>;
  getSpot(asset: string): Promise<SpotPrice>;
  /** Spot-market candles for the asset against USD, oldest first. Gemini returns about 60 days of hourly candles. */
  getCandles(asset: string, timeFrame: CandleTimeFrame): Promise<Candle[]>;
  listRecentlySettled(options?: SettledOptions): Promise<SettledEvent[]>;
  listCategories(): Promise<string[]>;
  /** Open ladders for an asset, soonest expiry first. */
  listLadders(asset: string): Promise<LadderListing[]>;
  getLadder(options: GetLadderOptions): Promise<Ladder>;
  clearCache(): void;
}

export function createGeminiClient(options: GeminiClientOptions = {}): GeminiClient {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ttl: CacheTtls = { ...DEFAULT_TTLS, ...options.cacheTtlMs };
  const http: HttpOptions = {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    limiter: new TokenBucket({
      capacity: options.rateLimit?.capacity ?? 5,
      refillPerMinute: options.rateLimit?.refillPerMinute ?? 100,
      now,
      sleep,
    }),
    sleep,
    random: options.random ?? Math.random,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 8_000,
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
  };
  const cache = new TtlCache(now);
  const isoNow = () => new Date(now()).toISOString();

  async function fetchEventPages(query: URLSearchParams, maxPages: number): Promise<RawEvent[]> {
    const events: RawEvent[] = [];
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams(query);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const path = `/v1/prediction-markets/events?${params.toString()}`;
      const body = await cache.getOrLoad(path, ttl.events, () => getJson(http, path, eventsResponseSchema));
      events.push(...body.data);
      const total = body.pagination?.total;
      if (body.data.length < PAGE_SIZE || (total !== undefined && (page + 1) * PAGE_SIZE >= total)) break;
    }
    // Events can shift between pages while paginating; keep the first copy of each ticker.
    const seen = new Set<string>();
    return events.filter((event) => !seen.has(event.ticker) && seen.add(event.ticker));
  }

  async function rawEvents(opts: ListEventsOptions): Promise<RawEvent[]> {
    const query = new URLSearchParams();
    for (const status of toList(opts.status ?? "active")) query.append("status", status);
    const categories = toList(
      opts.category ?? (opts.asset !== undefined || opts.kind !== undefined ? CRYPTO_CATEGORY : []),
    );
    for (const category of categories) query.append("category", category);
    if (opts.search !== undefined) query.set("search", opts.search);
    return fetchEventPages(query, opts.maxPages ?? 10);
  }

  async function listEvents(opts: ListEventsOptions = {}): Promise<EventSummary[]> {
    const asset = opts.asset?.toUpperCase();
    return (await rawEvents(opts))
      .map(summarizeEvent)
      .filter(
        (e) =>
          (asset === undefined || e.asset === asset) && (opts.kind === undefined || e.kind === opts.kind),
      );
  }

  async function getEvent(eventTicker: string): Promise<MarketEvent> {
    requireToken(eventTicker, "eventTicker");
    const path = eventPath(eventTicker);
    const raw = await cache.getOrLoad(path, ttl.event, () => getJson(http, path, eventSchema));
    return normalizeEvent(raw);
  }

  async function getOrderBook(instrumentSymbol: string): Promise<OrderBook> {
    requireToken(instrumentSymbol, "instrumentSymbol");
    const path = `/v1/book/${encodeURIComponent(instrumentSymbol)}`;
    const raw = await cache.getOrLoad(path, ttl.book, () => getJson(http, path, orderBookSchema));
    return normalizeBook(instrumentSymbol, raw, isoNow());
  }

  async function getSpot(asset: string): Promise<SpotPrice> {
    requireToken(asset, "asset");
    const upper = asset.toUpperCase();
    const path = `/v1/pubticker/${spotSymbol(upper)}`;
    const raw = await cache.getOrLoad(path, ttl.spot, () => getJson(http, path, tickerSchema));
    const spot = normalizeTicker(upper, raw, isoNow());
    if (spot === null) {
      throw new GeminiError("invalid_response", `GET ${path} returned no usable bid, ask or last price`, {
        path,
      });
    }
    return spot;
  }

  async function getCandles(asset: string, timeFrame: CandleTimeFrame): Promise<Candle[]> {
    requireToken(asset, "asset");
    requireToken(timeFrame, "timeFrame");
    const path = `/v2/candles/${spotSymbol(asset.toUpperCase())}/${timeFrame}`;
    const raw = await cache.getOrLoad(path, ttl.candles, () => getJson(http, path, candlesSchema));
    return normalizeCandles(raw);
  }

  async function listRecentlySettled(opts: SettledOptions = {}): Promise<SettledEvent[]> {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
      throw new GeminiError("invalid_argument", `limit must be an integer from 1 to ${PAGE_SIZE}`);
    }
    const asset = opts.asset?.toUpperCase();
    const query = new URLSearchParams();
    for (const category of toList(opts.category ?? (asset === undefined ? [] : CRYPTO_CATEGORY))) {
      query.append("category", category);
    }
    query.set("limit", String(limit));
    const path = `/v1/prediction-markets/events/recently-settled?${query.toString()}`;
    const body = await cache.getOrLoad(path, ttl.settled, () => getJson(http, path, eventsResponseSchema));
    return body.data.map(normalizeSettled).filter((e) => asset === undefined || e.asset === asset);
  }

  async function listCategories(): Promise<string[]> {
    const path = "/v1/prediction-markets/categories";
    const body = await cache.getOrLoad(path, ttl.categories, () => getJson(http, path, categoriesSchema));
    return body.categories;
  }

  async function listLadders(asset: string): Promise<LadderListing[]> {
    requireToken(asset, "asset");
    const upper = asset.toUpperCase();
    const nowMs = now();
    const listings: LadderListing[] = [];
    for (const raw of await rawEvents({ category: CRYPTO_CATEGORY })) {
      const listing = listingFromEvent(normalizeEvent(raw));
      if (listing === null || listing.asset !== upper) continue;
      if (Date.parse(listing.expiry) <= nowMs || listing.strikeCount === 0) continue;
      listings.push(listing);
    }
    return listings.sort(
      (a, b) => Date.parse(a.expiry) - Date.parse(b.expiry) || a.eventTicker.localeCompare(b.eventTicker),
    );
  }

  async function chooseEventTicker(opts: GetLadderOptions, asset: string): Promise<string> {
    if (opts.eventTicker !== undefined) return opts.eventTicker;
    if (opts.expiry === undefined && opts.horizon === undefined) {
      throw new GeminiError("invalid_argument", "getLadder needs an eventTicker, an expiry or a horizon");
    }
    const ladders = (await listLadders(asset)).filter((l) => l.openStrikeCount > 0);
    const available = ladders.map((l) => `${l.kind} ${l.expiry} (${l.eventTicker})`).join("; ") || "none";
    if (opts.expiry !== undefined) {
      const target = typeof opts.expiry === "string" ? Date.parse(opts.expiry) : opts.expiry.getTime();
      if (Number.isNaN(target)) throw new GeminiError("invalid_argument", "expiry is not a valid date");
      const match = ladders.find((l) => Date.parse(l.expiry) === target);
      if (match === undefined) {
        throw new GeminiError(
          "no_ladder",
          `No open ${asset} ladder expires at ${new Date(target).toISOString()}. Available: ${available}`,
        );
      }
      return match.eventTicker;
    }
    const match = ladders.find((l) => l.kind === opts.horizon);
    if (match === undefined) {
      throw new GeminiError(
        "no_ladder",
        `No open ${opts.horizon ?? ""} ${asset} ladder right now. Available: ${available}`,
      );
    }
    return match.eventTicker;
  }

  async function getLadder(opts: GetLadderOptions): Promise<Ladder> {
    requireToken(opts.asset, "asset");
    const asset = opts.asset.toUpperCase();
    const ticker = await chooseEventTicker(opts, asset);
    const [event, spot] = await Promise.all([getEvent(ticker), getSpot(asset)]);
    if (event.asset !== asset) {
      throw new GeminiError("no_ladder", `Event ${ticker} is not a ${asset} event`);
    }
    const depth = await fetchDepth(event, spot, opts.depth ?? "none");
    const ladder = buildLadder(event, spot, { fetchedAt: isoNow(), depth });
    if (ladder === null || ladder.rungs.length === 0) {
      throw new GeminiError("no_ladder", `Event ${ticker} is not a strike ladder`);
    }
    return ladder;
  }

  async function fetchDepth(
    event: MarketEvent,
    spot: SpotPrice,
    mode: DepthMode,
  ): Promise<Map<string, RungDepth>> {
    const depth = new Map<string, RungDepth>();
    if (mode === "none") return depth;
    const rungs = ladderRungs(event).filter((r) => r.marketState === "open");
    // "below-spot" also keeps the first strike at or above spot, the highest a hedge can start at.
    const firstAtOrAbove = rungs.find((r) => r.strikeCents >= spot.midCents)?.strikeCents;
    const limit = firstAtOrAbove ?? Number.POSITIVE_INFINITY;
    const symbols = rungs
      .filter((r) => mode === "all" || r.strikeCents <= limit)
      .map((r) => r.instrumentSymbol);
    // The token bucket paces these; Promise.all only overlaps the waiting.
    const books = await Promise.all(symbols.map((symbol) => getOrderBook(symbol)));
    for (const book of books) depth.set(book.instrumentSymbol, depthFromBook(book));
    return depth;
  }

  return {
    listEvents,
    getEvent,
    getOrderBook,
    getSpot,
    getCandles,
    listRecentlySettled,
    listCategories,
    listLadders,
    getLadder,
    clearCache: () => {
      cache.clear();
    },
  };
}

function toList(value: string | readonly string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}

function requireToken(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new GeminiError("invalid_argument", `${name} must be letters, digits, dot, dash or underscore`);
  }
}
