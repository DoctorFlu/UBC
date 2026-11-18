import * as z from "zod";
import { CATEGORY_IDS, categoryLabel, type CategoryId } from "@mandate/shared";

/** The first `max` items and whether any were cut, so a result can say the list is partial. */
export function capList<T>(items: readonly T[], max: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

export function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The text form beside an ISO time the agent may repeat to its owner. A model that works a weekday out of
 * an ISO time can get it wrong ("settles Thu Nov 20" for a Friday), so each one comes written out to copy.
 */
export const DateTextSchema = z
  .string()
  .describe(
    'The same time as the owner reads it, weekday included ("Fri Nov 20, 2026, 5:00 PM ET"). Copy it; never work out a weekday or date yourself',
  );

/** Category names as the mandate uses them: Crypto, Sports, Economics, Commodities, Weather, Politics, Other. */
export const CATEGORY_NAMES = CATEGORY_IDS.map((id) => categoryLabel(id)) as [string, ...string[]];
export const CategoryNameSchema = z.enum(CATEGORY_NAMES);

export function categoryIdOf(name: string): CategoryId {
  const id = CATEGORY_IDS.find((candidate) => categoryLabel(candidate) === name);
  if (id === undefined) throw new RangeError(`unknown category ${name}`);
  return id;
}

/** Arguments every trade tool takes, in the contract's units. */
export const tradeArgs = {
  market: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe(
      "Gemini instrumentSymbol exactly as list_markets or get_ladder returned it, e.g. GEMI-BTC2611202200-HI65000",
    ),
  outcome: z
    .enum(["YES", "NO"])
    .describe("Which side of the contract. Hedges buy NO on 'at or above' contracts"),
  side: z.enum(["buy", "sell"]).default("buy").describe("buy (default) or sell"),
  amountCents: z
    .int()
    .min(0)
    .max(100_000_000)
    .describe("Most to spend (buy) or the size (sell), in integer US cents: 1000 is $10.00"),
  limitPrice: z.int().min(1).max(99).describe("Limit price in cents per $1 contract, 1 to 99"),
};
