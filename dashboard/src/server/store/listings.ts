import "server-only";

import { type MarketListing, isCategoryId } from "@mandate/shared";

import type { Database } from "../db";

interface Row {
  symbol: string;
  listed: number;
  category: number | null;
  checked_at: string;
}

/** Most symbols per query, well under SQLite's limit on bound parameters. */
const CHUNK = 500;

/**
 * What Gemini said about each market symbol the first time the console checked it. The first verdict
 * wins and is kept: a market that has since settled keeps the verdict it had when its intent was seen.
 */
export class ListingStore {
  constructor(private readonly db: Database) {}

  /** The stored verdicts among `symbols`. */
  get(symbols: readonly string[]): Map<string, MarketListing> {
    const found = new Map<string, MarketListing>();
    for (let start = 0; start < symbols.length; start += CHUNK) {
      const chunk = symbols.slice(start, start + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT symbol, listed, category, checked_at FROM market_listings WHERE symbol IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as unknown as Row[];
      for (const row of rows) {
        const listing = fromRow(row);
        if (listing) found.set(row.symbol, listing);
      }
    }
    return found;
  }

  /** Stores a verdict unless one is stored already, and returns the stored one. */
  save(symbol: string, listing: MarketListing): MarketListing {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO market_listings (symbol, listed, category, checked_at) VALUES (?, ?, ?, ?)",
      )
      .run(symbol, listing.listed ? 1 : 0, listing.listed ? listing.category : null, listing.checkedAt);
    return this.get([symbol]).get(symbol) ?? listing;
  }
}

function fromRow(row: Row): MarketListing | null {
  if (row.listed === 0) return { listed: false, checkedAt: row.checked_at };
  if (row.category === null || !isCategoryId(row.category)) return null;
  return { listed: true, category: row.category, checkedAt: row.checked_at };
}
