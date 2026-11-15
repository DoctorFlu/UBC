/**
 * Public, normalized types. Every money value is integer cents and every contract quantity is
 * integer hundredths of a contract, converted once at the edge (see `units.ts`).
 */

/** Underlyings Gemini lists crypto ladders for today. Others may appear; asset fields stay strings. */
export const KNOWN_ASSETS = ["BTC", "ETH", "SOL", "XRP", "ZEC", "HYPE"] as const;
export type KnownAsset = (typeof KNOWN_ASSETS)[number];

/**
 * How long a crypto event runs, which is how an agent picks a hedge horizon.
 * Ladders ("at or above K" strike sets) come in the first four kinds. The two short kinds are
 * single-contract Up/Down events whose strike is captured at the start of the window.
 */
export type SeriesKind = "hourly" | "daily" | "weekly" | "month-end" | "15-minute" | "5-minute" | "other";

/** Ladder kinds an agent can ask for as a horizon. */
export type LadderKind = "hourly" | "daily" | "weekly" | "month-end";
export const LADDER_KINDS: readonly LadderKind[] = ["hourly", "daily", "weekly", "month-end"];

/**
 * One contract's quote, all in integer cents (1 contract pays 100 cents if it wins).
 * Every field is null when Gemini has no price for it (no resting orders on that side).
 */
export interface ContractQuote {
  /** `prices.buy.yes`: what you pay per YES contract to buy now (the best YES ask). Rounded up. */
  yesBuyCents: number | null;
  /** `prices.sell.yes`: what you receive per YES contract to sell now (the best YES bid). Rounded down. */
  yesSellCents: number | null;
  /**
   * `prices.buy.no`: what you pay per NO contract to buy now. Buying NO is matched against
   * YES bids, so this is normally 100 minus the best YES bid. Rounded up.
   */
  noBuyCents: number | null;
  /** `prices.sell.no`: what you receive per NO contract to sell now, normally 100 minus the best YES ask. Rounded down. */
  noSellCents: number | null;
  /** `prices.bestBid`: highest resting YES bid. Rounded down. */
  yesBidCents: number | null;
  /** `prices.bestAsk`: lowest resting YES ask. Rounded up. */
  yesAskCents: number | null;
  /** `prices.lastTradePrice`: YES price of the most recent trade, if any. Rounded half-up. */
  lastTradeCents: number | null;
}

export interface MarketContract {
  /** Symbol for the book, trades and orders, e.g. "GEMI-BTC2611202200-HI64000". Use as returned. */
  instrumentSymbol: string;
  /** Contract ticker within the event, e.g. "HI64000" or "UP". */
  ticker: string | null;
  /** Human label of the YES proposition, e.g. "$64,000 or above". */
  label: string | null;
  /** Lifecycle status: "active", "settled", and so on. */
  status: string | null;
  /** Trading state. The docs list "open" and "closed"; the live API also returns "post_only". */
  marketState: string | null;
  expiry: string | null;
  strike: {
    /** "above" for ladder rungs (YES wins if the final price is at or above the value), "reference" for Up/Down. */
    type: string | null;
    /** The strike as Gemini sent it. Null for Up/Down strikes not yet captured. */
    value: string | null;
    /** The strike in cents, rounded half-up when Gemini sends more precision. */
    valueCents: number | null;
  } | null;
  quote: ContractQuote;
  /** "yes" or "no" once settled. */
  resolutionSide: string | null;
  /** Observed settlement price, once settled. */
  settlementValue: string | null;
}

export interface MarketEvent {
  id: string;
  ticker: string;
  title: string;
  category: string | null;
  /** "binary" or "categorical". */
  type: string | null;
  status: string | null;
  expiry: string | null;
  /** Crypto underlying parsed from the ticker, e.g. "BTC"; null for non-crypto events. */
  asset: string | null;
  kind: SeriesKind | null;
  /** True when the event is a strike ladder of "at or above" contracts. */
  isLadder: boolean;
  /** Price index the event settles against, e.g. "LS-LRRR-XBTUSD". */
  settlementIndex: string | null;
  volumeCents: number | null;
  contracts: MarketContract[];
}

/** Compact event listing. Never carries contracts, so listing stays cheap for callers. */
export interface EventSummary {
  id: string;
  ticker: string;
  title: string;
  category: string | null;
  type: string | null;
  status: string | null;
  expiry: string | null;
  asset: string | null;
  kind: SeriesKind | null;
  isLadder: boolean;
  contractCount: number;
  volumeCents: number | null;
}

export interface SettledEvent {
  ticker: string;
  title: string;
  category: string | null;
  asset: string | null;
  kind: SeriesKind | null;
  resolvedAt: string | null;
  /** Observed settlement value as Gemini sent it, e.g. "64797.83733333334". */
  settlementValue: string | null;
  contracts: {
    instrumentSymbol: string;
    strikeCents: number | null;
    resolutionSide: string | null;
  }[];
}

export interface BookLevel {
  priceCents: number;
  quantityHundredths: number;
}

/**
 * Order book for one instrument. Both sides are YES-side: a NO buyer is filled by YES bids
 * (NO price = 100 - YES bid), so `bids[0].quantityHundredths` is the NO depth at the best NO price.
 */
export interface OrderBook {
  instrumentSymbol: string;
  /** Highest first. Prices rounded down. */
  bids: BookLevel[];
  /** Lowest first. Prices rounded up. */
  asks: BookLevel[];
  fetchedAt: string;
}

export interface SpotPrice {
  asset: string;
  /** Gemini spot symbol, e.g. "btcusd". */
  symbol: string;
  bidCents: number | null;
  askCents: number | null;
  lastCents: number | null;
  /**
   * Mid of bid and ask (falls back to last), rounded half-up. This is the exchange spot price,
   * which tracks but is not the index the ladder settles on.
   */
  midCents: number;
  fetchedAt: string;
}

/** Top-of-book size at the best price, in hundredths of a contract. */
export interface RungDepth {
  /** Size available to a NO buyer at `noBuyCents` (the size of the best YES bid). */
  noBuyHundredths: number;
  /** Size available to a YES buyer at `yesBuyCents` (the size of the best YES ask). */
  yesBuyHundredths: number;
}

export interface LadderRung {
  /** YES wins if the final index price is at or above this strike; NO wins below it. */
  strikeCents: number;
  instrumentSymbol: string;
  label: string | null;
  marketState: string | null;
  /** Best YES bid (`prices.bestBid`). */
  yesBidCents: number | null;
  /** Best YES ask (`prices.bestAsk`). */
  yesAskCents: number | null;
  /** Price to buy one NO contract now (`prices.buy.no`). */
  noBuyCents: number | null;
  /** Price received to sell one NO contract now (`prices.sell.no`). */
  noSellCents: number | null;
  lastTradeCents: number | null;
  /** Present only when depth was requested and the book was fetched for this rung. */
  depth?: RungDepth;
}

export interface Ladder {
  asset: string;
  eventTicker: string;
  title: string;
  kind: SeriesKind;
  /** ISO timestamp the contracts settle at. */
  expiry: string;
  /** Index the ladder settles on, e.g. "LS-LRRR-XBTUSD". */
  settlementIndex: string | null;
  spot: SpotPrice;
  /** Sorted by strike, lowest first. */
  rungs: LadderRung[];
  fetchedAt: string;
}

export interface LadderListing {
  eventTicker: string;
  title: string;
  asset: string;
  kind: SeriesKind;
  expiry: string;
  strikeCount: number;
  /** Rungs whose market state is "open". */
  openStrikeCount: number;
  lowestStrikeCents: number | null;
  highestStrikeCents: number | null;
}

/** Candle widths Gemini's public candles endpoint serves. */
export const CANDLE_TIME_FRAMES = ["1m", "5m", "15m", "30m", "1hr", "6hr", "1day"] as const;
export type CandleTimeFrame = (typeof CANDLE_TIME_FRAMES)[number];

/** One spot-market candle. Prices are integer cents, rounded half-up from Gemini's decimal. */
export interface Candle {
  /** Start of the candle's interval, in Unix milliseconds. */
  openTimeMs: number;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
}
