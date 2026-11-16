/**
 * Gemini prediction-market symbols, as the agent proposes them: `GEMI-BTC2611202200-HI65000` is the
 * contract "BTC settles at $65,000 or above" on the event that expires 2026-11-20 22:00 UTC.
 * The pattern follows `parseCryptoTicker` in @mandate/gemini: underlying, optional 05M/15M duration,
 * YYMMDDHHmm expiry in UTC, then the strike after `HI`.
 */
import { CATEGORY_LABELS, isCategoryId, isMarketSymbol } from "@mandate/shared";

const SYMBOL = /^GEMI-([A-Z]+?)(05M|15M)?(\d{10})-HI(\d+(?:\.\d+)?)$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MarketDescription {
  /**
   * "BTC $65,000 or above"; the symbol itself for another Gemini symbol; "Not a Gemini market" for text
   * that is not a symbol at all. Never the raw text of a non-symbol: only a stolen agent key writes one,
   * and it can be any length and say anything.
   */
  title: string;
  /** False when the market is not a Gemini symbol: show `preview` and flag it, never the raw text. */
  isSymbol: boolean;
  /** A short, single-line preview of a non-symbol market, for a quoted hint. Null for a symbol. */
  preview: string | null;
  /** Length in characters (code points) of the market as stored onchain. */
  length: number;
  /** "Nov 20, 22:00 UTC", when the symbol carries an expiry. */
  settles: string | null;
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

export function describeMarket(symbol: string): MarketDescription {
  const length = Array.from(symbol).length;
  if (!isMarketSymbol(symbol)) {
    return {
      title: "Not a Gemini market",
      isSymbol: false,
      preview: previewText(symbol),
      length,
      settles: null,
      symbol,
      asset: null,
      strike: null,
    };
  }
  const known = { isSymbol: true, preview: null, length };
  const match = SYMBOL.exec(symbol);
  if (!match) return { title: symbol, ...known, settles: null, symbol, asset: null, strike: null };
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
    settles: valid ? `${MONTHS[mm - 1] ?? ""} ${dd.toString()}, ${pad(hh)}:${pad(mi)} UTC` : null,
    symbol,
    asset,
    strike,
  };
}

/** "Crypto", or "Unknown (9)" for a category id this version does not know. */
export function categoryName(id: number | null): string {
  if (id === null) return "Unknown";
  return isCategoryId(id) ? CATEGORY_LABELS[id] : `Unknown (${id.toString()})`;
}
