/**
 * Read-only client for Gemini's public prediction-market and spot endpoints. No API key, no
 * authenticated route, no order placement: every call here is a public GET.
 */
import { formatEasternTime, raceAbort } from "@mandate/shared";
import type { RequestOptions } from "./abort";
import { TtlCache } from "./cache";
import { GeminiError } from "./errors";
import { getJson, type FetchLike, type HttpOptions } from "./http";
import {
  buildLadder,
  countMissingCandles,
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
  tradesSchema,
  type RawEvent,
} from "./schemas";
import {
  CANDLE_INTERVAL_MS,
  type Candle,
  type CandleTimeFrame,
  type EventSummary,
  type Ladder,
  type LadderKind,
  type LadderListing,
  type MarketEvent,
  type OrderBook,
  type RungDepth,
  type SeriesKind,
  type SettledEvent,
  type SpotPrice,
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
  /** Where listings, events and books are read. Default production. */
  baseUrl?: string;
  /**
   * Where spot prices and candles are read. Default `baseUrl`. A stack trading on the sandbox sets it to
   * production (`createMarketDataClient`): the ladders settle on production's index, and the sandbox's spot
   * market is far from it.
   */
  spotBaseUrl?: string;
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
  /**
   * Pause before asking again when a candle series comes back with candles missing inside it.
   * Default 1 s. The second request also waits for the token bucket like any other.
   */
  candleGapRetryDelayMs?: number;
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

/**
 * Every method takes `RequestOptions` last: its `signal` stops the call (see `RequestOptions`).
 */
export interface GeminiClient {
  listEvents(options?: ListEventsOptions, request?: RequestOptions): Promise<EventSummary[]>;
  getEvent(eventTicker: string, request?: RequestOptions): Promise<MarketEvent>;
  getOrderBook(instrumentSymbol: string, request?: RequestOptions): Promise<OrderBook>;
  getSpot(asset: string, request?: RequestOptions): Promise<SpotPrice>;
  /**
   * Spot-market candles for the asset against USD, oldest first. Gemini returns about 60 days of hourly
   * candles. Gemini sometimes answers with candles missing inside the series (issue #98: 14 hourly rows
   * gone in one answer, all present five seconds later), so an answer with a gap is asked for once more
   * and whichever answer misses fewer candles is kept and cached. A gap that remains is returned as it
   * is: missing candles are never filled in.
   */
  getCandles(asset: string, timeFrame: CandleTimeFrame, request?: RequestOptions): Promise<Candle[]>;
  listRecentlySettled(options?: SettledOptions, request?: RequestOptions): Promise<SettledEvent[]>;
  listCategories(request?: RequestOptions): Promise<string[]>;
  /** Open ladders for an asset, soonest expiry first. */
  listLadders(asset: string, request?: RequestOptions): Promise<LadderListing[]>;
  getLadder(options: GetLadderOptions, request?: RequestOptions): Promise<Ladder>;
  clearCache(): void;
}

/**
 * The widest spread, in basis points of the mid, at which spot is the mid of bid and ask (0.5 %). A wider
 * one takes the last trade instead, while that trade is at most `MAX_LAST_TRADE_AGE_MS` old.
 */
export const MAX_SPOT_SPREAD_BPS = 50;
export const MAX_LAST_TRADE_AGE_MS = 5 * 60_000;

/** "1.56 %" for 156 basis points. */
function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)} %`;
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
  const spotHttp: HttpOptions = {
    ...http,
    baseUrl: (options.spotBaseUrl ?? http.baseUrl).replace(/\/+$/, ""),
  };
  const cache = new TtlCache(now);
  const candleGapRetryDelayMs = options.candleGapRetryDelayMs ?? 1_000;
  const isoNow = () => new Date(now()).toISOString();

  async function fetchEventPages(
    query: URLSearchParams,
    maxPages: number,
    signal: AbortSignal | undefined,
  ): Promise<RawEvent[]> {
    const events: RawEvent[] = [];
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams(query);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const path = `/v1/prediction-markets/events?${params.toString()}`;
      const body = await cache.getOrLoad(
        path,
        ttl.events,
        (shared) => getJson(http, path, eventsResponseSchema, shared),
        signal,
      );
      events.push(...body.data);
      const total = body.pagination?.total;
      if (body.data.length < PAGE_SIZE || (total !== undefined && (page + 1) * PAGE_SIZE >= total)) break;
    }
    // Events can shift between pages while paginating; keep the first copy of each ticker.
    const seen = new Set<string>();
    return events.filter((event) => !seen.has(event.ticker) && seen.add(event.ticker));
  }

  async function rawEvents(opts: ListEventsOptions, signal: AbortSignal | undefined): Promise<RawEvent[]> {
    const query = new URLSearchParams();
    for (const status of toList(opts.status ?? "active")) query.append("status", status);
    const categories = toList(
      opts.category ?? (opts.asset !== undefined || opts.kind !== undefined ? CRYPTO_CATEGORY : []),
    );
    for (const category of categories) query.append("category", category);
    if (opts.search !== undefined) query.set("search", opts.search);
    return fetchEventPages(query, opts.maxPages ?? 10, signal);
  }

  async function listEvents(
    opts: ListEventsOptions = {},
    request: RequestOptions = {},
  ): Promise<EventSummary[]> {
    const asset = opts.asset?.toUpperCase();
    return (await rawEvents(opts, request.signal))
      .map(summarizeEvent)
      .filter(
        (e) =>
          (asset === undefined || e.asset === asset) && (opts.kind === undefined || e.kind === opts.kind),
      );
  }

  async function getEvent(eventTicker: string, request: RequestOptions = {}): Promise<MarketEvent> {
    requireToken(eventTicker, "eventTicker");
    const path = eventPath(eventTicker);
    const raw = await cache.getOrLoad(
      path,
      ttl.event,
      (shared) => getJson(http, path, eventSchema, shared),
      request.signal,
    );
    return normalizeEvent(raw);
  }

  async function getOrderBook(instrumentSymbol: string, request: RequestOptions = {}): Promise<OrderBook> {
    requireToken(instrumentSymbol, "instrumentSymbol");
    const path = `/v1/book/${encodeURIComponent(instrumentSymbol)}`;
    const raw = await cache.getOrLoad(
      path,
      ttl.book,
      (shared) => getJson(http, path, orderBookSchema, shared),
      request.signal,
    );
    return normalizeBook(instrumentSymbol, raw, isoNow());
  }

  async function getSpot(asset: string, request: RequestOptions = {}): Promise<SpotPrice> {
    requireToken(asset, "asset");
    const upper = asset.toUpperCase();
    const path = `/v1/pubticker/${spotSymbol(upper)}`;
    const raw = await cache.getOrLoad(
      path,
      ttl.spot,
      (shared) => getJson(spotHttp, path, tickerSchema, shared),
      request.signal,
    );
    const spot = normalizeTicker(upper, raw, isoNow());
    if (spot === null) {
      throw new GeminiError("invalid_response", `GET ${path} returned no usable bid, ask or last price`, {
        path,
      });
    }
    if ((spot.spreadBps ?? 0) <= MAX_SPOT_SPREAD_BPS) return spot;
    // A spread this wide (18 November 2026, during Gemini's incident: $64,242.83 / $65,249.98) puts the mid
    // hundreds of dollars from any price that traded. The last trade stands in while it is recent; an old
    // one means the market is not trading, and nothing is measured from it.
    const unavailable = (why: string) =>
      new GeminiError(
        "spot_unavailable",
        `Gemini's ${upper}/USD spot market is not trading normally: the spread is ${formatBps(spot.spreadBps ?? 0)} wide, and ${why}.`,
        { path },
      );
    if (spot.lastCents === null || spot.lastCents <= 0) throw unavailable("there is no last trade");
    const tradesPath = `/v1/trades/${spotSymbol(upper)}?limit_trades=1`;
    const trades = await cache.getOrLoad(
      tradesPath,
      ttl.spot,
      (shared) => getJson(spotHttp, tradesPath, tradesSchema, shared),
      request.signal,
    );
    const lastAt = trades[0]?.timestampms;
    if (lastAt === undefined) throw unavailable("there is no last trade");
    const ageMs = now() - lastAt;
    if (ageMs > MAX_LAST_TRADE_AGE_MS) {
      throw unavailable(`its last trade was ${String(Math.round(ageMs / 60_000))} minutes ago`);
    }
    return { ...spot, midCents: spot.lastCents, basis: "last" };
  }

  async function getCandles(
    asset: string,
    timeFrame: CandleTimeFrame,
    request: RequestOptions = {},
  ): Promise<Candle[]> {
    requireToken(asset, "asset");
    requireToken(timeFrame, "timeFrame");
    const path = `/v2/candles/${spotSymbol(asset.toUpperCase())}/${timeFrame}`;
    // A copy, so no caller can reorder the cached series for the next one.
    return [
      ...(await cache.getOrLoad(
        path,
        ttl.candles,
        (shared) => loadCandles(path, CANDLE_INTERVAL_MS[timeFrame], shared),
        request.signal,
      )),
    ];
  }

  /** One request, and one more only when the first answer has candles missing inside it. */
  async function loadCandles(path: string, intervalMs: number, signal: AbortSignal): Promise<Candle[]> {
    const first = normalizeCandles(await getJson(spotHttp, path, candlesSchema, signal));
    const firstMissing = countMissingCandles(first, intervalMs);
    if (firstMissing === 0) return first;
    await raceAbort(sleep(candleGapRetryDelayMs), signal);
    let second: Candle[];
    try {
      second = normalizeCandles(await getJson(spotHttp, path, candlesSchema, signal));
    } catch {
      // The first answer is still a real answer; its gap is the caller's to handle.
      return first;
    }
    return countMissingCandles(second, intervalMs) <= firstMissing ? second : first;
  }

  async function listRecentlySettled(
    opts: SettledOptions = {},
    request: RequestOptions = {},
  ): Promise<SettledEvent[]> {
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
    const body = await cache.getOrLoad(
      path,
      ttl.settled,
      (shared) => getJson(http, path, eventsResponseSchema, shared),
      request.signal,
    );
    return body.data.map(normalizeSettled).filter((e) => asset === undefined || e.asset === asset);
  }

  async function listCategories(request: RequestOptions = {}): Promise<string[]> {
    const path = "/v1/prediction-markets/categories";
    const body = await cache.getOrLoad(
      path,
      ttl.categories,
      (shared) => getJson(http, path, categoriesSchema, shared),
      request.signal,
    );
    return body.categories;
  }

  async function listLadders(asset: string, request: RequestOptions = {}): Promise<LadderListing[]> {
    requireToken(asset, "asset");
    const upper = asset.toUpperCase();
    const nowMs = now();
    const listings: LadderListing[] = [];
    for (const raw of await rawEvents({ category: CRYPTO_CATEGORY }, request.signal)) {
      const listing = listingFromEvent(normalizeEvent(raw));
      if (listing === null || listing.asset !== upper) continue;
      if (Date.parse(listing.expiry) <= nowMs || listing.strikeCount === 0) continue;
      listings.push(listing);
    }
    return listings.sort(
      (a, b) => Date.parse(a.expiry) - Date.parse(b.expiry) || a.eventTicker.localeCompare(b.eventTicker),
    );
  }

  async function chooseEventTicker(
    opts: GetLadderOptions,
    asset: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (opts.eventTicker !== undefined) return opts.eventTicker;
    if (opts.expiry === undefined && opts.horizon === undefined) {
      throw new GeminiError("invalid_argument", "getLadder needs an eventTicker, an expiry or a horizon");
    }
    const ladders = (await listLadders(asset, { signal })).filter((l) => l.openStrikeCount > 0);
    // Each expiry written out for the owner, weekday included, and as the ISO time a caller passes back.
    const available =
      ladders
        .map(
          (l) => `${l.kind} ${l.eventTicker}, settling ${formatEasternTime(l.expiry)} (expiry ${l.expiry})`,
        )
        .join("; ") || "none";
    if (opts.expiry !== undefined) {
      const target = typeof opts.expiry === "string" ? Date.parse(opts.expiry) : opts.expiry.getTime();
      if (Number.isNaN(target)) throw new GeminiError("invalid_argument", "expiry is not a valid date");
      const match = ladders.find((l) => Date.parse(l.expiry) === target);
      if (match === undefined) {
        throw new GeminiError(
          "no_ladder",
          `No open ${asset} ladder expires at ${formatEasternTime(new Date(target))} (${new Date(target).toISOString()}). Available: ${available}`,
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

  async function getLadder(opts: GetLadderOptions, request: RequestOptions = {}): Promise<Ladder> {
    requireToken(opts.asset, "asset");
    const asset = opts.asset.toUpperCase();
    const ticker = await chooseEventTicker(opts, asset, request.signal);
    const [event, spot] = await Promise.all([getEvent(ticker, request), getSpot(asset, request)]);
    if (event.asset !== asset) {
      throw new GeminiError("no_ladder", `Event ${ticker} is not a ${asset} event`);
    }
    const depth = await fetchDepth(event, spot, opts.depth ?? "none", request);
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
    request: RequestOptions,
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
    const books = await Promise.all(symbols.map((symbol) => getOrderBook(symbol, request)));
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
