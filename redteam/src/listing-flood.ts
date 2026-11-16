/**
 * Replays intents read from the chain through the console's listing checker (`ListingChecker`, the same
 * class the console runs) against a Gemini that makes every lookup cost the most it can, on a simulated
 * clock, and reports what the checker sent and when. No real Gemini is asked.
 */
import {
  GeminiError,
  LISTING_REQUEST_BUDGET,
  ListingChecker,
  type ListingCandidate,
  findInstrument,
  listingOrder,
} from "@mandate/gemini";
import type { MarketListing } from "@mandate/shared";

/** The console's Gemini client tries each request at most twice (one retry). */
export const CONSOLE_ATTEMPTS_PER_REQUEST = 2;
/** The most requests the checker may send in any 60 s. */
export const LISTING_CAP_PER_MINUTE = LISTING_REQUEST_BUDGET.burst + LISTING_REQUEST_BUDGET.perMinute;
const MINUTE = 60_000;

export interface ListingFlood {
  /** The symbols looked up, in order. */
  asked: string[];
  /** When each request was sent, in ms from the start. */
  sentAt: number[];
  /** The most requests sent in any 60-second window. */
  busiestMinute: number;
}

/**
 * Runs the checker for `minutes` of simulated time over `intents`, re-reading them each simulated second
 * the way the console rebuilds its snapshot. Every candidate event ticker of every symbol is missing and
 * each request is retried once before Gemini says so: the worst case a flood of invented symbols can force.
 */
export async function floodListingChecks(
  intents: readonly ListingCandidate[],
  minutes: number,
): Promise<ListingFlood> {
  let now = 0;
  let sleepers: { at: number; wake: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      sleepers.push({ at: now + ms, wake: resolve });
    });
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const asked: string[] = [];
  const sentAt: number[] = [];
  const saved = new Map<string, MarketListing>();
  const checker = new ListingChecker({
    lookup: async (symbol) => {
      asked.push(symbol);
      let requests = 0;
      // Gemini lists none of them, so this is always null.
      await findInstrument((ticker) => {
        for (let attempt = 0; attempt < CONSOLE_ATTEMPTS_PER_REQUEST; attempt++) sentAt.push(now);
        requests += CONSOLE_ATTEMPTS_PER_REQUEST;
        return Promise.reject(new GeminiError("not_found", `no event ${ticker}`));
      }, symbol);
      return { category: null, requests };
    },
    store: {
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
    },
    attemptsPerRequest: CONSOLE_ATTEMPTS_PER_REQUEST,
    now: () => now,
    sleep,
  });

  const order = listingOrder(intents);
  for (let second = 0; second <= minutes * 60; second++) {
    now = second * 1_000;
    for (;;) {
      const due = sleepers.filter((s) => s.at <= now);
      if (due.length === 0) break;
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due) s.wake();
      await settle();
    }
    checker.listings(order);
    await settle();
  }
  checker.stop();

  let busiestMinute = 0;
  for (const start of sentAt) {
    busiestMinute = Math.max(busiestMinute, sentAt.filter((t) => t >= start && t < start + MINUTE).length);
  }
  return { asked, sentAt, busiestMinute };
}
