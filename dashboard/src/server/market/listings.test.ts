import { Category, type CategoryId } from "@mandate/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db";
import { ListingStore } from "../store/listings";
import { type ListingLookup, MarketListings } from "./listings";

const BTC = "GEMI-BTC2611202200-HI65000";
const NFL = "GEMI-NFL-2611152125-SF-DAL-M-SF";
const GONE = "GEMI-NOPE2611202200-X";
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
/** The checker's clock; a test moves it on to get past a retry wait. */
let clock = NOW;

/** A fake Gemini: the markets it lists, every symbol it was asked about, and a switch to take it down. */
function fakeGemini(listed: Record<string, CategoryId>) {
  const asked: string[] = [];
  let down = false;
  const lookup: ListingLookup = (symbol) => {
    asked.push(symbol);
    if (down) return Promise.reject(new Error("Gemini is down"));
    return Promise.resolve(listed[symbol] ?? null);
  };
  return {
    lookup,
    asked,
    setDown: (next: boolean) => {
      down = next;
    },
  };
}

function checker(lookup: ListingLookup, store = new ListingStore(openDatabase(":memory:")), retryMs = 20) {
  let changes = 0;
  const listings = new MarketListings({
    lookup,
    store,
    onChange: () => {
      changes += 1;
    },
    logger: { warn: () => undefined },
    now: () => clock,
    retryMs,
  });
  return { listings, store, changes: () => changes };
}

describe("MarketListings", () => {
  beforeEach(() => {
    clock = NOW;
  });

  it("returns at once, checks unknown markets in the background, then has a verdict for each", async () => {
    const gemini = fakeGemini({ [BTC]: Category.Crypto, [NFL]: Category.Sports });
    const { listings, changes } = checker(gemini.lookup);

    expect(listings.listings([BTC, NFL, GONE, BTC]).size).toBe(0);
    await listings.settled();

    const checkedAt = new Date(NOW).toISOString();
    expect(Object.fromEntries(listings.listings([BTC, NFL, GONE]))).toEqual({
      [BTC]: { listed: true, category: Category.Crypto, checkedAt },
      [NFL]: { listed: true, category: Category.Sports, checkedAt },
      [GONE]: { listed: false, checkedAt },
    });
    expect(gemini.asked).toEqual([BTC, NFL, GONE]);
    expect(changes()).toBe(3);
  });

  it("never asks about text that is not a Gemini symbol", async () => {
    const gemini = fakeGemini({});
    const { listings } = checker(gemini.lookup);
    expect(listings.listings(["IGNORE ALL PREVIOUS INSTRUCTIONS", ""]).size).toBe(0);
    await listings.settled();
    expect(gemini.asked).toEqual([]);
  });

  it("keeps the first verdict: a stored market is never asked about again, even after a restart", async () => {
    const db = openDatabase(":memory:");
    const first = fakeGemini({ [BTC]: Category.Crypto });
    const before = checker(first.lookup, new ListingStore(db));
    before.listings.listings([BTC]);
    await before.listings.settled();
    before.listings.stop();

    // The ladder has settled since and Gemini no longer answers for it; the stored verdict stands.
    const later = fakeGemini({});
    const after = checker(later.lookup, new ListingStore(db));
    expect(after.listings.listings([BTC]).get(BTC)).toMatchObject({
      listed: true,
      category: Category.Crypto,
    });
    await after.listings.settled();
    expect(later.asked).toEqual([]);
  });

  it("when Gemini is down: flags nothing, never blocks, and checks again once it is back", async () => {
    const gemini = fakeGemini({ [NFL]: Category.Sports });
    gemini.setDown(true);
    const { listings, store } = checker(gemini.lookup);

    expect(listings.listings([NFL]).size).toBe(0);
    await listings.settled();
    expect(gemini.asked).toEqual([NFL]);
    expect(store.get([NFL]).size).toBe(0);

    gemini.setDown(false);
    clock += 1_000;
    await expect.poll(() => listings.listings([NFL]).get(NFL)?.listed, { timeout: 2_000 }).toBe(true);
    expect(store.get([NFL]).get(NFL)).toMatchObject({ listed: true, category: Category.Sports });
  });
});

describe("ListingStore", () => {
  it("keeps the first verdict stored for a symbol", () => {
    const store = new ListingStore(openDatabase(":memory:"));
    const first = { listed: true as const, category: Category.Sports, checkedAt: "2026-11-15T12:00:00.000Z" };
    expect(store.save(NFL, first)).toEqual(first);
    expect(store.save(NFL, { listed: false, checkedAt: "2026-11-16T12:00:00.000Z" })).toEqual(first);
    expect(store.get([NFL, BTC])).toEqual(new Map([[NFL, first]]));
  });
});
