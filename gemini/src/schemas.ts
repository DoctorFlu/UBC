/**
 * Response schemas for Gemini's public REST API.
 *
 * They validate only the fields we use. `z.object` strips unknown keys, so new fields Gemini
 * adds (and heavy ones we ignore, such as rich-text descriptions) neither break parsing nor
 * travel further than this module. Optional and nullable are applied generously because the
 * live API omits fields the docs list (for example `bestBid` on a contract with no bids, or
 * `buy.yes` on a settled contract).
 */
import { z } from "zod";

const decimalString = z.string();
const optionalDecimal = decimalString.nullish();

export const priceSideSchema = z.object({
  yes: optionalDecimal,
  no: optionalDecimal,
});

export const contractPricesSchema = z.object({
  buy: priceSideSchema.nullish(),
  sell: priceSideSchema.nullish(),
  bestBid: optionalDecimal,
  bestAsk: optionalDecimal,
  lastTradePrice: optionalDecimal,
});

export const strikeSchema = z.object({
  type: z.string().nullish(),
  value: optionalDecimal,
  availableAt: z.string().nullish(),
});

export const contractSchema = z.object({
  id: z.string().nullish(),
  label: z.string().nullish(),
  ticker: z.string().nullish(),
  instrumentSymbol: z.string(),
  status: z.string().nullish(),
  marketState: z.string().nullish(),
  expiryDate: z.string().nullish(),
  effectiveDate: z.string().nullish(),
  strike: strikeSchema.nullish(),
  prices: contractPricesSchema.nullish(),
  quantityIncrement: optionalDecimal,
  quantityMinimum: optionalDecimal,
  priceIncrement: optionalDecimal,
  resolutionSide: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  settlementValue: optionalDecimal,
});

export const eventTagSchema = z.object({
  slug: z.string().nullish(),
  name: z.string().nullish(),
});

export const eventSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  ticker: z.string(),
  title: z.string(),
  slug: z.string().nullish(),
  type: z.string().nullish(),
  category: z.string().nullish(),
  series: z.string().nullish(),
  status: z.string().nullish(),
  template: z.string().nullish(),
  createdAt: z.string().nullish(),
  effectiveDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  volume: optionalDecimal,
  volume24h: optionalDecimal,
  tags: z.array(z.string()).nullish(),
  eventTags: z.array(eventTagSchema).nullish(),
  sourceDetails: z
    .object({
      agency: z.string().nullish(),
      index: z.string().nullish(),
    })
    .nullish(),
  settlement: z.object({ value: optionalDecimal }).nullish(),
  contracts: z.array(contractSchema).nullish(),
});

export const paginationSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const eventsResponseSchema = z.object({
  data: z.array(eventSchema),
  pagination: paginationSchema.nullish(),
});

export const bookLevelSchema = z.object({
  price: decimalString,
  amount: decimalString,
});

export const orderBookSchema = z.object({
  bids: z.array(bookLevelSchema),
  asks: z.array(bookLevelSchema),
});

export const tickerSchema = z.object({
  bid: optionalDecimal,
  ask: optionalDecimal,
  last: optionalDecimal,
});

/** `GET /v2/candles/:symbol/:timeFrame`: `[timeMs, open, high, low, close, volume]` rows, newest first. */
export const candlesSchema = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
);

export const categoriesSchema = z.object({
  categories: z.array(z.string()),
});

export type RawContract = z.infer<typeof contractSchema>;
export type RawEvent = z.infer<typeof eventSchema>;
export type RawEventsResponse = z.infer<typeof eventsResponseSchema>;
export type RawOrderBook = z.infer<typeof orderBookSchema>;
export type RawTicker = z.infer<typeof tickerSchema>;
export type RawCandles = z.infer<typeof candlesSchema>;
