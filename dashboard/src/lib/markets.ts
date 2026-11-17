/**
 * Gemini prediction-market symbols, as the agent proposes them: `GEMI-BTC2611202200-HI65000` is the
 * contract "BTC settles at $65,000 or above" on the event that expires 2026-11-20 22:00 UTC.
 * The pattern follows `parseCryptoTicker` in @mandate/gemini: underlying, optional 05M/15M duration,
 * YYMMDDHHmm expiry in UTC, then the strike after `HI`.
 */
import { CATEGORY_LABELS, Category, type MarketListing, isCategoryId, isMarketSymbol } from "@mandate/shared";

const SYMBOL = /^GEMI-([A-Z]+?)(05M|15M)?(\d{10})-HI(\d+(?:\.\d+)?)$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MarketDescription {
  /**
   * "BTC $65,000 or above"; "Sports market" (from the intent's category) for another Gemini symbol, whose
   * names only Gemini's listing knows; "Not a Gemini market" for text that is not a symbol at all. Never
   * the raw text of a non-symbol: only a stolen agent key writes one, and it can be any length and say
   * anything.
   */
  title: string;
  /** True when the title was read from the symbol itself (the crypto price ladders). */
  parsed: boolean;
  /** False when the market is not a Gemini symbol: show `preview` and flag it, never the raw text. */
  isSymbol: boolean;
  /** A short, single-line preview of a non-symbol market, for a quoted hint. Null for a symbol. */
  preview: string | null;
  /** Length in characters (code points) of the market as stored onchain. */
  length: number;
  /** "Nov 20, 22:00 UTC", when the symbol carries an expiry. */
  settles: string | null;
  /** The same expiry as an ISO time, for comparing with the clock. */
  expiresAt: string | null;
  symbol: string;
  asset: string | null;
  /** Strike in dollars, as written in the symbol. */
  strike: string | null;
}

function groupThousands(digits: string): string {
  const [whole = "", fraction] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** At most `max` characters of onchain text on one line: control characters and runs of space become one space. */
export function previewText(value: string, max = 48): string {
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : chars.join("");
}

/**
 * The name of a Gemini market whose symbol this console does not parse. Gemini's other symbols follow no
 * one pattern (`GEMI-NBA-2611170000-ORL-BOS-M-BOS`, `GEMI-GOLF-AUS-T10-20261115-PAN`) and their team or
 * player names live only in Gemini's listing, so the name comes from the category the intent carries.
 */
function unparsedTitle(category: number | null): string {
  if (category === null || !isCategoryId(category) || category === Category.Other) return "Gemini market";
  return `${CATEGORY_LABELS[category]} market`;
}

export function describeMarket(symbol: string, category: number | null = null): MarketDescription {
  const length = Array.from(symbol).length;
  if (!isMarketSymbol(symbol)) {
    return {
      title: "Not a Gemini market",
      parsed: false,
      isSymbol: false,
      preview: previewText(symbol),
      length,
      settles: null,
      expiresAt: null,
      symbol,
      asset: null,
      strike: null,
    };
  }
  const known = { isSymbol: true, preview: null, length };
  const match = SYMBOL.exec(symbol);
  if (!match) {
    return {
      title: unparsedTitle(category),
      parsed: false,
      ...known,
      settles: null,
      expiresAt: null,
      symbol,
      asset: null,
      strike: null,
    };
  }
  const [, asset = "", , stamp = "", strike = ""] = match;
  const [yy, mm, dd, hh, mi] = [0, 2, 4, 6, 8].map((index) => Number(stamp.slice(index, index + 2))) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi));
  const valid = date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd && hh < 24 && mi < 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return {
    ...known,
    title: `${asset} $${groupThousands(strike)} or above`,
    parsed: true,
    settles: valid ? `${MONTHS[mm - 1] ?? ""} ${dd.toString()}, ${pad(hh)}:${pad(mi)} UTC` : null,
    expiresAt: valid ? date.toISOString() : null,
    symbol,
    asset,
    strike,
  };
}

/**
 * The category that names an unparsed market: Gemini's own, once the console checked the listing, else the
 * one the intent carries. A key that mislabels a Sports market as Crypto still gets "Sports market", beside
 * the flag that says so.
 */
export function namingCategory(intent: {
  category: number | null;
  listing?: MarketListing | undefined;
}): number | null {
  return intent.listing?.listed ? intent.listing.category : intent.category;
}

/** "Crypto", or "Unknown (9)" for a category id this version does not know. */
export function categoryName(id: number | null): string {
  if (id === null) return "Unknown";
  return isCategoryId(id) ? CATEGORY_LABELS[id] : `Unknown (${id.toString()})`;
}
