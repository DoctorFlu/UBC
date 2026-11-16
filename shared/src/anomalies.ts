/**
 * What a stored intent says that this system's own agent server could never have sent. The contract
 * enforces only the amount rules: it stores any market, outcome and limit price, and trusts the category.
 * The MCP server validates all of them before proposing, so each anomaly here means the agent key was used
 * around the server (a stolen key). Readers flag such intents; they never act on, or relay, their text.
 *
 * A reader that also checks the market against Gemini's listing (the console does, as the executor does
 * before it trades) passes the answer as `listing`, which adds two anomalies: a market Gemini does not
 * list, and a category other than the one Gemini lists the market under. The MCP server reads the
 * category from Gemini, so neither comes from it either.
 */
import { type CategoryId, categoryLabel, isCategoryId } from "./categories";

import { isValidLimitPrice } from "./units";

/** The longest market symbol accepted anywhere; every listed Gemini symbol is far shorter. */
export const MAX_MARKET_SYMBOL_LENGTH = 128;

/** Gemini instrument symbols: `GEMI-<event ticker>-<contract ticker>`, letters, digits, `.`, `_`, `-`. */
const MARKET_SYMBOL = /^GEMI-[A-Za-z0-9._-]+$/;

/** Whether a string has the shape of a Gemini instrument symbol. It says nothing about whether it is listed. */
export function isMarketSymbol(value: string): boolean {
  return value.length <= MAX_MARKET_SYMBOL_LENGTH && MARKET_SYMBOL.test(value);
}

export type AnomalyCode =
  | "market"
  | "outcome"
  | "category"
  | "limit_price"
  | "out_of_range"
  | "market_not_listed"
  | "category_mismatch";

/**
 * What Gemini said about a market the first time a reader checked it: not listed, or listed under a
 * mandate category. Kept as first seen, so a market that has since settled keeps its verdict.
 */
export type MarketListing =
  { listed: false; checkedAt: string } | { listed: true; category: CategoryId; checkedAt: string };

export interface IntentAnomaly {
  code: AnomalyCode;
  /** One plain clause, for example "outcome is not YES or NO". Describes the value, never quotes it. */
  text: string;
}

/** The fields an anomaly check reads. Null means the field is not known (no event carried it). */
export interface AnomalyFields {
  market: string | null;
  outcome: string | null;
  category: number | null;
  limitPrice: number | null;
  outOfRange?: Readonly<Record<string, string>> | undefined;
  /** Gemini's listing of `market`, when the reader checked it. Absent means not checked (yet). */
  listing?: MarketListing | undefined;
}

const FIELD_NAMES: Record<string, string> = {
  amountCents: "amount",
  limitPrice: "limit price",
  filledCents: "filled amount",
  pnlCents: "profit and loss",
};

/** Everything about an intent this system's agent server would never have sent; empty for a normal intent. */
export function intentAnomalies(intent: AnomalyFields): IntentAnomaly[] {
  const found: IntentAnomaly[] = [];
  if (intent.market !== null && !isMarketSymbol(intent.market)) {
    found.push({ code: "market", text: "market is not a Gemini symbol" });
  }
  const listing = intent.listing;
  if (listing !== undefined && intent.market !== null && isMarketSymbol(intent.market)) {
    if (!listing.listed) {
      found.push({ code: "market_not_listed", text: "Gemini does not list this market" });
    } else if (
      intent.category !== null &&
      isCategoryId(intent.category) &&
      intent.category !== listing.category
    ) {
      found.push({
        code: "category_mismatch",
        text: `Gemini lists this market as ${categoryLabel(listing.category)}, the intent says ${categoryLabel(intent.category)}`,
      });
    }
  }
  if (intent.outcome !== null && intent.outcome !== "YES" && intent.outcome !== "NO") {
    found.push({ code: "outcome", text: "outcome is not YES or NO" });
  }
  if (intent.category !== null && !isCategoryId(intent.category)) {
    found.push({ code: "category", text: `category ${intent.category.toString()} is not a known category` });
  }
  if (intent.limitPrice !== null && !isValidLimitPrice(intent.limitPrice)) {
    found.push({
      code: "limit_price",
      text: `limit price ${intent.limitPrice.toString()} is outside 1 to 99`,
    });
  }
  for (const field of Object.keys(intent.outOfRange ?? {})) {
    found.push({
      code: "out_of_range",
      text: `${FIELD_NAMES[field] ?? field} is too large for offchain code`,
    });
  }
  return found;
}
