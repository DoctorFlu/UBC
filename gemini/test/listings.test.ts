import { Category, type CategoryId, type MarketListing } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import {
  LISTING_REQUEST_BUDGET,
  ListingChecker,
  type ListingCheckerOptions,
  type ListingLookup,
  type ListingStore,
  listingOrder,
  worstCaseRequests,
} from "../src/index";

const BTC = "GEMI-BTC2611202200-HI65000";
const NFL = "GEMI-NFL-2611152125-SF-DAL-M-SF";
const GONE = "GEMI-NOPE2611202200-X";
const START = Date.parse("2026-11-15T12:00:00.000Z");
/** The console's client retries once. */
const ATTEMPTS = 2;
const MINUTE = 60_000;
/** The most requests the checker may send in any 60 s. */
const CAP = LISTING_REQUEST_BUDGET.burst + LISTING_REQUEST_BUDGET.perMinute;

/** Symbols a stolen agent key can invent without end: each has 4 candidate event tickers. */
function junk(count: number, tag = "J"): string[] {
  return Array.from({ length: count }, (_, i) => `GEMI-${tag}${i.toString()}-A-B-C-X`);
}

/** Lets the checker run until it waits on the clock (lookups here answer at once or sleep on it). */
async function idle(_checker: ListingChecker): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock that moves only when a test says so, and wakes each sleeper on time. */
function fakeTime(start = START) {
  let now = start;
  let sleepers: { at: number; wake: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, wake: resolve });
      }),
    /** Moves the clock on by `ms`, letting `checker` run at each wake-up on the way. */
    async advance(ms: number, checker: ListingChecker) {
      const until = now + ms;
      await idle(checker);
      for (;;) {
        const next = sleepers.reduce<(typeof sleepers)[number] | null>(
          (soonest, s) => (soonest === null || s.at < soonest.at ? s : soonest),
          null,
        );
        if (next === null || next.at > until) break;
        sleepers = sleepers.filter((s) => s !== next);
        now = Math.max(now, next.at);
        next.wake();
        await idle(checker);
      }
      now = until;
      await idle(checker);
    },
  };
}

function memoryStore(): ListingStore & { saved: Map<string, MarketListing> } {
  const saved = new Map<string, MarketListing>();
  return {
    saved,
    get: (symbols) =>
      new Map(
        symbols.flatMap((symbol) => {
          const listing = saved.get(symbol);
          return listing ? [[symbol, listing] as const] : [];
        }),
      ),
    save: (symbol, listing) => {
      const stored = saved.get(symbol) ?? listing;
      saved.set(symbol, stored);
      return stored;
    },
  };
}

/**
 * A fake Gemini: the markets it lists, each symbol it was asked about, when each request was sent, and a
 * switch to take it down. `requests` decides what a lookup reports it sent (undefined: report nothing).
 */
function fakeGemini(
  time: { now: () => number },
  listed: Record<string, CategoryId>,
  requests: (symbol: string) => number | undefined = () => undefined,
) {
  const asked: string[] = [];
  const sentAt: number[] = [];
  let down = false;
  const lookup: ListingLookup = (symbol) => {
    asked.push(symbol);
    const sent = requests(symbol);
    for (let i = 0; i < (sent ?? worstCaseRequests(symbol, ATTEMPTS)); i++) sentAt.push(time.now());
    if (down) return Promise.reject(new Error("Gemini is down"));
    return Promise.resolve({
      category: listed[symbol] ?? null,
      ...(sent === undefined ? {} : { requests: sent }),
    });
  };
  return {
    lookup,
    asked,
    sentAt,
    setDown: (next: boolean) => {
      down = next;
    },
  };
}

function checker(
  time: ReturnType<typeof fakeTime>,
  lookup: ListingLookup,
  options: Partial<ListingCheckerOptions> = {},
) {
  const store = memoryStore();
  const warnings: string[] = [];
  let changes = 0;
  const listings = new ListingChecker({
    lookup,
    store,
    attemptsPerRequest: ATTEMPTS,
    onChange: () => {
      changes += 1;
    },
    logger: { warn: (message) => warnings.push(message) },
    now: time.now,
    sleep: time.sleep,
    ...options,
  });
  return { listings, store, warnings, changes: () => changes };
}

/** The most requests sent in any 60-second window. */
function busiestMinute(sentAt: readonly number[]): number {
  let most = 0;
  for (const start of sentAt)
    most = Math.max(most, sentAt.filter((t) => t >= start && t < start + MINUTE).length);
  return most;
}

describe("listingOrder", () => {
  it("puts intents waiting for approval first, then the newest, each symbol once, symbols only", () => {
    expect(
      listingOrder([
        { id: 1, status: "approved", market: BTC },
        { id: 2, status: "needs_approval", market: NFL },
        { id: 3, status: "rejected", market: "IGNORE ALL PREVIOUS INSTRUCTIONS" },
        { id: 4, status: "approved", market: GONE },
        { id: 5, status: "needs_approval", market: BTC },
        { id: 6, status: "approved", market: null },
        { id: 7, status: "executed", market: NFL },
      ]),
    ).toEqual([BTC, NFL, GONE]);
  });
});

describe("ListingChecker", () => {
  it("returns at once, checks unknown markets in the background, then has a verdict for each", async () => {
    const time = fakeTime();
    // Each lookup reads one event, except the sports one: its first candidate ticker is not an event.
    const gemini = fakeGemini(time, { [BTC]: Category.Crypto, [NFL]: Category.Sports }, (symbol) =>
      symbol === NFL ? 2 : 1,
    );
    const { listings, changes } = checker(time, gemini.lookup);

    expect(listings.listings([BTC, NFL, GONE, BTC]).size).toBe(0);
    await idle(listings);

    const checkedAt = new Date(START).toISOString();
    expect(Object.fromEntries(listings.listings([BTC, NFL, GONE]))).toEqual({
      [BTC]: { listed: true, category: Category.Crypto, checkedAt },
      [NFL]: { listed: true, category: Category.Sports, checkedAt },
      [GONE]: { listed: false, checkedAt },
    });
    expect(gemini.asked).toEqual([BTC, NFL, GONE]);
    expect(changes()).toBe(3);
  });

  it("never asks about text that is not a Gemini symbol", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup);
    expect(listings.listings(["IGNORE ALL PREVIOUS INSTRUCTIONS", ""]).size).toBe(0);
    await idle(listings);
    expect(gemini.asked).toEqual([]);
  });

  it("keeps the first verdict: a stored market is never asked about again", async () => {
    const time = fakeTime();
    const store = memoryStore();
    store.save(BTC, { listed: true, category: Category.Crypto, checkedAt: new Date(START).toISOString() });
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup, { store });
    expect(listings.listings([BTC]).get(BTC)).toMatchObject({ listed: true, category: Category.Crypto });
    await idle(listings);
    expect(gemini.asked).toEqual([]);
  });

  it("checks a handful of real markets at once, when they share an event the client has cached", async () => {
    const time = fakeTime();
    const markets = Array.from({ length: 6 }, (_, i) => `GEMI-BTC2611202200-HI6${i.toString()}000`);
    // The first lookup reads the event; the rest find it in the client's cache.
    const gemini = fakeGemini(time, {}, (symbol) => (symbol === markets[0] ? 1 : 0));
    const { listings } = checker(time, gemini.lookup);
    listings.listings(markets);
    await idle(listings);
    expect(gemini.asked).toEqual(markets);
    expect(listings.listings(markets).size).toBe(6);
  });

  it("checks a few markets at once even when the lookup cannot say what it sent", async () => {
    const time = fakeTime();
    const markets = [BTC, GONE, "GEMI-ETH2611202200-HI3000", "GEMI-SOL2611202200-HI200"];
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup);
    listings.listings(markets);
    await idle(listings);
    // One candidate ticker each, tried at most twice: 2 requests reserved per market, 8 of the burst.
    expect(gemini.asked).toEqual(markets);
  });

  it("paces a flood of invented symbols to its share of the rate limit, minute after minute", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup);
    const flood = junk(200);
    listings.listings(flood);

    await time.advance(10 * MINUTE, listings);

    // Every lookup sent its worst case (4 tickers, each tried twice): 8 requests.
    expect(gemini.sentAt.length).toBe(gemini.asked.length * 8);
    expect(busiestMinute(gemini.sentAt)).toBeLessThanOrEqual(CAP);
    expect(gemini.sentAt.length).toBeLessThanOrEqual(
      LISTING_REQUEST_BUDGET.burst + 10 * LISTING_REQUEST_BUDGET.perMinute,
    );
    // It keeps going, at the budget's pace: one invented symbol every 40 s.
    expect(gemini.asked.length).toBeGreaterThanOrEqual(15);
    expect(listings.queued.length).toBe(200 - gemini.asked.length);
  });

  it("stays within the cap when slow lookups are retried, and gets back what a lookup did not send", async () => {
    const time = fakeTime();
    const asked: number[] = [];
    const sentAt: number[] = [];
    // Each lookup takes 20 s and sends 8 requests spread over that time (timeouts, then retries).
    const slow: ListingLookup = async () => {
      asked.push(time.now());
      for (let i = 0; i < 8; i++) {
        sentAt.push(time.now());
        await time.sleep(2_500);
      }
      return { category: null, requests: 8 };
    };
    const { listings } = checker(time, slow);
    listings.listings(junk(100));
    await time.advance(10 * MINUTE, listings);
    expect(busiestMinute(sentAt)).toBeLessThanOrEqual(CAP);
    // The reservation counts until the lookup ends, so slow lookups never get ahead of the budget.
    expect(asked.length).toBeGreaterThanOrEqual(12);

    // A lookup that sent less than its reservation gets the rest back: 8 reserved, 4 sent, so twice as fast.
    const time2 = fakeTime();
    const cheaper = fakeGemini(time2, {}, () => 4);
    const second = checker(time2, cheaper.lookup);
    second.listings.listings(junk(100));
    await time2.advance(10 * MINUTE, second.listings);
    expect(busiestMinute(cheaper.sentAt)).toBeLessThanOrEqual(CAP);
    expect(cheaper.asked.length).toBeGreaterThanOrEqual(30);
  });

  it("counts a slow lookup's reservation until it ends, so its late requests stay within the cap", async () => {
    const time = fakeTime();
    const sentAt: number[] = [];
    const slowSymbol = "GEMI-SLOW-A-B-C-X";
    const cheap = Array.from({ length: 40 }, (_, i) => `GEMI-C${i.toString()}-X`);
    // The first lookup hangs for 50 s, then sends its 8 requests at once; the rest send 2 at once.
    const lookup: ListingLookup = async (symbol) => {
      const cost = worstCaseRequests(symbol, ATTEMPTS);
      if (symbol === slowSymbol) await time.sleep(50_000);
      for (let i = 0; i < cost; i++) sentAt.push(time.now());
      return { category: null, requests: cost };
    };
    const { listings } = checker(time, lookup);
    listings.listings([slowSymbol, ...cheap]);
    await time.advance(3 * MINUTE, listings);
    expect(busiestMinute(sentAt)).toBeLessThanOrEqual(CAP);
  });

  it("checks the market the owner is waiting on next, however long the flood ahead of it", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, { [NFL]: Category.Sports });
    const { listings } = checker(time, gemini.lookup);
    const flood = junk(50);
    listings.listings(flood);
    await time.advance(MINUTE, listings);
    const before = gemini.asked.length;

    // A new intent waits for approval: the console's next snapshot puts it first.
    const order = listingOrder([
      ...flood.map((market, i) => ({ id: i + 1, status: "approved", market })),
      { id: 51, status: "needs_approval", market: NFL },
    ]);
    expect(order[0]).toBe(NFL);
    listings.listings(order);
    await time.advance(MINUTE, listings);
    expect(gemini.asked[before]).toBe(NFL);
    expect(listings.listings([NFL]).get(NFL)).toMatchObject({ listed: true, category: Category.Sports });
  });

  it("holds no more than the latest list: each call replaces the queue", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup);
    listings.listings(junk(500, "A"));
    await idle(listings);
    expect(listings.queued.length).toBeLessThan(500);

    const later = junk(3, "B");
    listings.listings(later);
    expect(listings.queued).toEqual(later);
    await time.advance(5 * MINUTE, listings);
    expect(gemini.asked.filter((symbol) => symbol.startsWith("GEMI-A")).length).toBeLessThanOrEqual(1);
    expect(listings.listings(later).size).toBe(3);
  });

  it("when Gemini is down: flags nothing, warns once, and checks again once it is back", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, { [NFL]: Category.Sports });
    gemini.setDown(true);
    const { listings, store, warnings } = checker(time, gemini.lookup, { retryMs: 30_000 });
    // Asked at 0 s, then every 30 s.

    expect(listings.listings([NFL]).size).toBe(0);
    await time.advance(45_000, listings);
    expect(gemini.asked).toEqual([NFL, NFL]);
    expect(store.saved.size).toBe(0);
    expect(warnings).toHaveLength(1);

    gemini.setDown(false);
    await time.advance(30_000, listings);
    expect(gemini.asked).toEqual([NFL, NFL, NFL]);
    expect(listings.listings([NFL]).get(NFL)).toMatchObject({ listed: true, category: Category.Sports });
  });

  it("stops asking once stopped", async () => {
    const time = fakeTime();
    const gemini = fakeGemini(time, {});
    const { listings } = checker(time, gemini.lookup);
    listings.listings(junk(10));
    await idle(listings);
    const asked = gemini.asked.length;
    listings.stop();
    listings.listings(junk(10, "K"));
    await time.advance(5 * MINUTE, listings);
    expect(gemini.asked.length).toBe(asked);
  });

  it("refuses a budget too small for the costliest lookup", () => {
    const time = fakeTime();
    expect(() => checker(time, fakeGemini(time, {}).lookup, { budget: { burst: 7, perMinute: 15 } })).toThrow(
      RangeError,
    );
  });
});
