import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { canonicalJson } from "./context";

/**
 * Wire contract of the paid hedge signal (issue #20) between the seller (`@mandate/signals`) and the
 * buyer (the MCP server's `buy_signal` tool, issue #21). Both sides parse with these schemas, so drift
 * fails loudly.
 *
 * Units: prices and money are integer cents, probabilities and edges are integer basis points of one
 * dollar (10000 bps = 100 cents = a sure thing), volatility is integer basis points per year. Nothing
 * in the document is a float, so its canonical JSON, and therefore `signalId`, is the same everywhere.
 */
export const HEDGE_SIGNAL_PATH = "/v1/signal/hedge";
export const HEDGE_SIGNAL_VERSION = 1;

/** Ladder horizons the signal can be asked for, as `@mandate/gemini` names them. */
export const SIGNAL_HORIZONS = ["hourly", "daily", "weekly", "month-end"] as const;
export type SignalHorizon = (typeof SIGNAL_HORIZONS)[number];

/**
 * What buying NO at a strike costs against the model's value of it.
 * - `cheap`: the NO ask is below the model value by at least the fair band.
 * - `fair`: within the band either way.
 * - `expensive`: above the model value by at least the band.
 * - `no_offer`: the market is not open or nobody sells NO (no YES bids), so there is no price to judge.
 */
export const PROTECTION_VERDICTS = ["cheap", "fair", "expensive", "no_offer"] as const;
export type ProtectionVerdict = (typeof PROTECTION_VERDICTS)[number];

/** Which sides of a strike's YES book had resting orders. */
export const BOOK_STATES = ["two_sided", "no_bids", "no_asks", "empty"] as const;
export type BookState = (typeof BOOK_STATES)[number];

const isoDateTime = z.iso.datetime({ offset: true });
const cents = z.int().nonnegative();
const probabilityBps = z.int().min(0).max(10_000);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, { message: "must be 0x and 64 lower-case hex digits" });

// Query

const assetParam = z
  .string()
  .regex(/^[A-Za-z0-9]{2,10}$/, { message: "asset must be 2 to 10 letters or digits, for example BTC" })
  .transform((value) => value.toUpperCase());

/**
 * Query of `GET /v1/signal/hedge`: an asset and exactly one way to pick its ladder.
 * `eventTicker` names it (for example `BTC2611202200`), `expiry` matches its settlement instant, and
 * `horizon` takes the soonest open ladder of that kind.
 */
export const hedgeSignalQuerySchema = z
  .strictObject({
    asset: assetParam,
    eventTicker: z
      .string()
      .regex(/^[A-Z0-9]{4,40}$/, { message: "eventTicker must be upper-case letters and digits" })
      .optional(),
    expiry: isoDateTime.optional(),
    horizon: z.enum(SIGNAL_HORIZONS).optional(),
  })
  .refine(
    (query) =>
      [query.eventTicker, query.expiry, query.horizon].filter((value) => value !== undefined).length === 1,
    { message: "pass exactly one of eventTicker, expiry or horizon" },
  );
export type HedgeSignalQuery = z.output<typeof hedgeSignalQuerySchema>;

/** The search string for a query, in a fixed parameter order so equal queries give equal URLs. */
export function hedgeSignalSearch(query: HedgeSignalQuery): string {
  const params = new URLSearchParams({ asset: query.asset });
  if (query.eventTicker !== undefined) params.set("eventTicker", query.eventTicker);
  if (query.expiry !== undefined) params.set("expiry", query.expiry);
  if (query.horizon !== undefined) params.set("horizon", query.horizon);
  return `?${params.toString()}`;
}

// Response

export const hedgeSignalStrikeSchema = z.strictObject({
  /** YES wins if the settlement price is at or above this strike; NO (the protection) wins below it. */
  strikeCents: z.int().positive(),
  instrumentSymbol: z.string().min(1),
  /** Gemini market state, for example `open`. */
  marketState: z.string().nullable(),
  book: z.enum(BOOK_STATES),
  /** Best YES bid and ask in cents, or null when that side of the book is empty. */
  yesBidCents: cents.nullable(),
  yesAskCents: cents.nullable(),
  /** Market-implied probability of finishing at or above the strike: the YES mid. Null unless two-sided. */
  impliedYesBps: probabilityBps.nullable(),
  /** The model's probability of finishing at or above the strike. */
  modelYesBps: probabilityBps,
  /** What one NO contract costs now (the protection price), or null when nobody sells it. */
  noAskCents: cents.nullable(),
  /** The model's value of one NO contract: 10000 minus `modelYesBps`. */
  fairNoBps: probabilityBps,
  /** `fairNoBps - noAskCents x 100`: positive means protection costs less than the model says it is worth. */
  edgeBps: z.int().nullable(),
  /** `edgeBps / 100` rounded half away from zero, in cents per contract. */
  edgeCents: z.int().nullable(),
  verdict: z.enum(PROTECTION_VERDICTS),
});
export type HedgeSignalStrike = z.infer<typeof hedgeSignalStrikeSchema>;

export const hedgeSignalSchema = z.strictObject({
  version: z.literal(HEDGE_SIGNAL_VERSION),
  /** keccak256 of the canonical JSON of every other field. Cite it with the payment receipt. */
  signalId: hex32,
  asset: z.string().min(1),
  eventTicker: z.string().min(1),
  /** Ladder kind, for example `weekly`. */
  horizon: z.string().min(1),
  /** When the ladder settles. */
  expiry: isoDateTime,
  /** When the signal was computed. */
  asOf: isoDateTime,
  secondsToExpiry: z.int().positive(),
  spot: z.strictObject({
    /** Gemini spot mid used as the model's starting price. */
    midCents: z.int().positive(),
    /** For example `gemini:btcusd`. */
    source: z.string().min(1),
    fetchedAt: isoDateTime,
  }),
  volatility: z.strictObject({
    /** Annualized realised volatility, in basis points (4500 = 45 % a year). */
    annualizedBps: z.int().nonnegative(),
    method: z.literal("close-to-close"),
    candle: z.literal("1hr"),
    /** Number of hourly log returns the estimate used. */
    returns: z.int().positive(),
    /** Open time of the first candle and close time of the last candle used. */
    from: isoDateTime,
    to: isoDateTime,
    source: z.string().min(1),
  }),
  model: z.strictObject({
    name: z.literal("lognormal-driftless"),
    /** Edge needed, either way, before a strike is called cheap or expensive. */
    fairBandBps: z.int().nonnegative(),
    assumptions: z.array(z.string().min(1)).min(1),
  }),
  /** Every strike of the ladder, lowest first. */
  strikes: z.array(hedgeSignalStrikeSchema).min(1),
  counts: z.strictObject({
    cheap: z.int().nonnegative(),
    fair: z.int().nonnegative(),
    expensive: z.int().nonnegative(),
    noOffer: z.int().nonnegative(),
  }),
});
export type HedgeSignal = z.infer<typeof hedgeSignalSchema>;
export type HedgeSignalBody = Omit<HedgeSignal, "signalId">;

/** keccak256 over the canonical JSON of a signal without its id. */
export function hedgeSignalId(body: HedgeSignalBody): Hex {
  return keccak256(stringToBytes(canonicalJson(body)));
}

/** True when the document is a valid signal whose `signalId` matches its content. Never throws. */
export function verifyHedgeSignal(value: unknown): value is HedgeSignal {
  const parsed = hedgeSignalSchema.safeParse(value);
  if (!parsed.success) return false;
  const { signalId, ...body } = parsed.data;
  return hedgeSignalId(body) === signalId;
}

// Errors

/**
 * Codes of the free refusals the seller answers before asking for payment, so a buyer never pays
 * for a signal the seller cannot produce.
 */
export const SIGNAL_ERROR_CODES = [
  /** 400: the query does not match `hedgeSignalQuerySchema`. */
  "invalid_query",
  /** 404: the seller does not cover this asset. */
  "unknown_asset",
  /** 404: no open ladder matches the selection. */
  "no_ladder",
  /** 422: the ladder settles too soon to model. */
  "expired",
  /** 503: not enough recent price history to estimate volatility. Retry later. */
  "insufficient_history",
  /** 503: Gemini could not be reached. Retry later. */
  "market_data_unavailable",
] as const;
export type SignalErrorCode = (typeof SIGNAL_ERROR_CODES)[number];

/**
 * Body of a refusal. `error` is the plain message, the shape x402 clients expect (Circle's
 * `GatewayClient` reports it as "Payment failed: <error>"); `code` is for machines.
 */
export const signalErrorSchema = z.strictObject({
  error: z.string().min(1),
  code: z.enum(SIGNAL_ERROR_CODES),
});
export type SignalError = z.infer<typeof signalErrorSchema>;
