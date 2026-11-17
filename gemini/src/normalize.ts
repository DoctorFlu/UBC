/**
 * Pure conversions from validated raw responses to the public types. No I/O here, so the
 * agent, the dashboard and tests can all build ladders from recorded data.
 */
import type { RawCandles, RawContract, RawEvent, RawOrderBook, RawTicker } from "./schemas";
import type {
  Candle,
  ContractQuote,
  EventSummary,
  Ladder,
  LadderListing,
  LadderRung,
  MarketContract,
  MarketEvent,
  OrderBook,
  RungDepth,
  SeriesKind,
  SettledEvent,
  SpotPrice,
} from "./types";
import { toCents, toHundredths } from "./units";

/** Crypto event tickers: underlying, optional 05M/15M duration marker, YYMMDDHHmm expiry in UTC. */
const CRYPTO_TICKER = /^([A-Z]+?)(05M|15M)?(\d{10})$/;

export function parseCryptoTicker(
  ticker: string,
): { asset: string; duration: "05M" | "15M" | null; expiry: string } | null {
  const match = CRYPTO_TICKER.exec(ticker);
  if (!match) return null;
  const [, asset, duration, stamp] = match;
  if (asset === undefined || stamp === undefined) return null;
  const [yy, mm, dd, hh, mi] = [0, 2, 4, 6, 8].map((i) => Number(stamp.slice(i, i + 2))) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi));
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  return {
    asset,
    duration: duration === "05M" || duration === "15M" ? duration : null,
    expiry: date.toISOString(),
  };
}

const TAG_KINDS: Record<string, SeriesKind> = {
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
  monthly: "month-end",
  "five-minute": "5-minute",
  "fifteen-minute": "15-minute",
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Classify a crypto event's horizon. Gemini tags most events ("hourly", "daily", "monthly",
 * "five-minute", "fifteen-minute"), but the weekly ladders carry only a "reference" tag, so
 * untagged events fall back to the ticker's duration marker and then to the event's span.
 */
export function classifyKind(event: RawEvent): SeriesKind | null {
  const parsed = parseCryptoTicker(event.ticker);
  if (parsed === null || !isCrypto(event)) return null;
  for (const tag of event.eventTags ?? []) {
    const kind = TAG_KINDS[(tag.slug ?? "").toLowerCase()];
    if (kind !== undefined) return kind;
  }
  if (parsed.duration === "05M") return "5-minute";
  if (parsed.duration === "15M") return "15-minute";
  const expiry = Date.parse(event.expiryDate ?? parsed.expiry);
  const start = Date.parse(event.effectiveDate ?? event.createdAt ?? "");
  if (Number.isNaN(expiry) || Number.isNaN(start)) return "other";
  const span = expiry - start;
  if (span > 20 * DAY_MS) return "month-end";
  if (span > 2 * DAY_MS) return "weekly";
  if (span > 2 * HOUR_MS) return "daily";
  return "hourly";
}

function isCrypto(event: RawEvent): boolean {
  return (event.category ?? "").toLowerCase() === "crypto";
}

export function normalizeQuote(prices: RawContract["prices"]): ContractQuote {
  return {
    yesBuyCents: toCents(prices?.buy?.yes, "up"),
    yesSellCents: toCents(prices?.sell?.yes, "down"),
    noBuyCents: toCents(prices?.buy?.no, "up"),
    noSellCents: toCents(prices?.sell?.no, "down"),
    yesBidCents: toCents(prices?.bestBid, "down"),
    yesAskCents: toCents(prices?.bestAsk, "up"),
    lastTradeCents: toCents(prices?.lastTradePrice, "half-up"),
  };
}

export function normalizeContract(contract: RawContract): MarketContract {
  const strike = contract.strike;
  return {
    instrumentSymbol: contract.instrumentSymbol,
    ticker: contract.ticker ?? null,
    label: contract.label ?? null,
    status: contract.status ?? null,
    marketState: contract.marketState ?? null,
    expiry: contract.expiryDate ?? null,
    strike:
      strike === null || strike === undefined
        ? null
        : {
            type: strike.type ?? null,
            value: strike.value ?? null,
            valueCents: toCents(strike.value, "half-up"),
          },
    quote: normalizeQuote(contract.prices),
    resolutionSide: contract.resolutionSide ?? null,
    settlementValue: contract.settlementValue ?? null,
  };
}

function isLadderEvent(event: RawEvent): boolean {
  if (!isCrypto(event)) return false;
  if (event.template === "prices-ladder") return true;
  return (event.contracts ?? []).some((c) => c.strike?.type === "above");
}

export function normalizeEvent(event: RawEvent): MarketEvent {
  const parsed = isCrypto(event) ? parseCryptoTicker(event.ticker) : null;
  return {
    id: event.id,
    ticker: event.ticker,
    title: event.title,
    category: event.category ?? null,
    type: event.type ?? null,
    status: event.status ?? null,
    expiry: event.expiryDate ?? parsed?.expiry ?? null,
    asset: parsed?.asset ?? null,
    kind: classifyKind(event),
    isLadder: isLadderEvent(event),
    settlementIndex: event.sourceDetails?.index ?? null,
    volumeCents: toCents(event.volume, "half-up"),
    contracts: (event.contracts ?? []).map(normalizeContract),
  };
}

export function summarizeEvent(event: RawEvent): EventSummary {
  const parsed = isCrypto(event) ? parseCryptoTicker(event.ticker) : null;
  return {
    id: event.id,
    ticker: event.ticker,
    title: event.title,
    category: event.category ?? null,
    type: event.type ?? null,
    status: event.status ?? null,
    expiry: event.expiryDate ?? parsed?.expiry ?? null,
    asset: parsed?.asset ?? null,
    kind: classifyKind(event),
    isLadder: isLadderEvent(event),
    contractCount: event.contracts?.length ?? 0,
    volumeCents: toCents(event.volume, "half-up"),
  };
}

export function normalizeSettled(event: RawEvent): SettledEvent {
  const parsed = isCrypto(event) ? parseCryptoTicker(event.ticker) : null;
  const firstContract = event.contracts?.[0];
  return {
    ticker: event.ticker,
    title: event.title,
    category: event.category ?? null,
    asset: parsed?.asset ?? null,
    kind: classifyKind(event),
    resolvedAt: event.resolvedAt ?? firstContract?.resolvedAt ?? null,
    settlementValue: event.settlement?.value ?? firstContract?.settlementValue ?? null,
    contracts: (event.contracts ?? []).map((c) => ({
      instrumentSymbol: c.instrumentSymbol,
      strikeCents: toCents(c.strike?.value, "half-up"),
      resolutionSide: c.resolutionSide ?? null,
    })),
  };
}

export function listingFromEvent(event: MarketEvent): LadderListing | null {
  if (!event.isLadder || event.asset === null || event.kind === null || event.expiry === null) return null;
  const rungs = ladderRungs(event);
  return {
    eventTicker: event.ticker,
    title: event.title,
    asset: event.asset,
    kind: event.kind,
    expiry: event.expiry,
    strikeCount: rungs.length,
    openStrikeCount: rungs.filter((r) => r.marketState === "open").length,
    lowestStrikeCents: rungs[0]?.strikeCents ?? null,
    highestStrikeCents: rungs.at(-1)?.strikeCents ?? null,
  };
}

/**
 * The "at or above" rungs of a ladder event, sorted by strike (lowest first). Contracts whose
 * strike is not exactly representable in cents are skipped rather than silently rounded,
 * because a rounded strike would misstate which side wins.
 */
export function ladderRungs(event: MarketEvent, depth?: ReadonlyMap<string, RungDepth>): LadderRung[] {
  const rungs: LadderRung[] = [];
  for (const contract of event.contracts) {
    if (contract.strike?.type !== "above" || contract.strike.value === null) continue;
    const strikeCents = toCents(contract.strike.value, "exact");
    if (strikeCents === null) continue;
    const rungDepth = depth?.get(contract.instrumentSymbol);
    rungs.push({
      strikeCents,
      instrumentSymbol: contract.instrumentSymbol,
      label: contract.label,
      marketState: contract.marketState,
      yesBidCents: contract.quote.yesBidCents,
      yesAskCents: contract.quote.yesAskCents,
      noBuyCents: contract.quote.noBuyCents,
      noSellCents: contract.quote.noSellCents,
      lastTradeCents: contract.quote.lastTradeCents,
      ...(rungDepth === undefined ? {} : { depth: rungDepth }),
    });
  }
  return rungs.sort((a, b) => a.strikeCents - b.strikeCents);
}

/** Build a typed ladder from an event and a spot price. Returns null if the event is not a ladder. */
export function buildLadder(
  event: MarketEvent,
  spot: SpotPrice,
  options: { fetchedAt: string; depth?: ReadonlyMap<string, RungDepth> },
): Ladder | null {
  if (!event.isLadder || event.asset === null || event.kind === null || event.expiry === null) return null;
  return {
    asset: event.asset,
    eventTicker: event.ticker,
    title: event.title,
    kind: event.kind,
    expiry: event.expiry,
    settlementIndex: event.settlementIndex,
    spot,
    rungs: ladderRungs(event, options.depth),
    fetchedAt: options.fetchedAt,
  };
}

export function normalizeBook(instrumentSymbol: string, raw: RawOrderBook, fetchedAt: string): OrderBook {
  const levels = (side: RawOrderBook["bids"], rounding: "up" | "down") =>
    side.flatMap((level) => {
      const priceCents = toCents(level.price, rounding);
      const quantityHundredths = toHundredths(level.amount);
      return priceCents === null || quantityHundredths === null ? [] : [{ priceCents, quantityHundredths }];
    });
  return {
    instrumentSymbol,
    bids: levels(raw.bids, "down").sort((a, b) => b.priceCents - a.priceCents),
    asks: levels(raw.asks, "up").sort((a, b) => a.priceCents - b.priceCents),
    fetchedAt,
  };
}

/** Top-of-book depth for a rung, from its YES-side book. */
export function depthFromBook(book: OrderBook): RungDepth {
  return {
    noBuyHundredths: book.bids[0]?.quantityHundredths ?? 0,
    yesBuyHundredths: book.asks[0]?.quantityHundredths ?? 0,
  };
}

export function normalizeTicker(asset: string, raw: RawTicker, fetchedAt: string): SpotPrice | null {
  const bidCents = toCents(raw.bid, "half-up");
  const askCents = toCents(raw.ask, "half-up");
  const lastCents = toCents(raw.last, "half-up");
  let midCents: number | null = null;
  if (bidCents !== null && askCents !== null && bidCents > 0 && askCents >= bidCents) {
    // Half-up on the integer mid keeps this exact: (bid + ask) / 2 has at most a .5 remainder.
    midCents = Math.floor((bidCents + askCents + 1) / 2);
  } else if (lastCents !== null && lastCents > 0) {
    midCents = lastCents;
  }
  if (midCents === null) return null;
  return {
    asset,
    symbol: spotSymbol(asset),
    bidCents,
    askCents,
    lastCents,
    midCents,
    fetchedAt,
  };
}

export function spotSymbol(asset: string): string {
  return `${asset.toLowerCase()}usd`;
}

/**
 * Candles in time order, oldest first, with prices in integer cents. Gemini sends candle prices
 * as JSON numbers; each is converted through its shortest decimal string, so no float arithmetic
 * touches a price. Rows with a price that has no plain decimal form (exponent notation, negative,
 * zero) and repeated timestamps are dropped.
 */
export function normalizeCandles(raw: RawCandles): Candle[] {
  const byTime = new Map<number, Candle>();
  const cents = (value: number): number | null => {
    const converted = toCents(String(value), "half-up");
    return converted === null || converted <= 0 ? null : converted;
  };
  for (const [time, open, high, low, close] of raw) {
    if (!Number.isSafeInteger(time) || time < 0 || byTime.has(time)) continue;
    const openCents = cents(open);
    const highCents = cents(high);
    const lowCents = cents(low);
    const closeCents = cents(close);
    if (openCents === null || highCents === null || lowCents === null || closeCents === null) continue;
    byTime.set(time, { openTimeMs: time, openCents, highCents, lowCents, closeCents });
  }
  return [...byTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/**
 * How many candles are missing between the oldest and the newest of a series sorted oldest first,
 * for candles `intervalMs` wide. Only gaps inside the series count: a series that starts late or ends
 * early is shorter, not gapped.
 */
export function countMissingCandles(candles: readonly Candle[], intervalMs: number): number {
  let missing = 0;
  for (let i = 1; i < candles.length; i++) {
    const step = (candles[i]?.openTimeMs ?? 0) - (candles[i - 1]?.openTimeMs ?? 0);
    missing += Math.max(0, Math.round(step / intervalMs) - 1);
  }
  return missing;
}
