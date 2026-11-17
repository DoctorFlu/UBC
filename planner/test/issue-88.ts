/**
 * The hosted state from issue #88 (17 Nov 2026), rebuilt from the issue: 0.05 BTC, goal "protected
 * below $63,000 for the nearest expiry, at most $45 per plan", on BTC2611202200.
 *
 * - Run 1 (01:25) bought 4 NO orders, HI64500 to HI63000, for $29.65.
 * - Run 4 (02:07) bought the same 4 strikes again for $31.58, about 99% covered already.
 * - All 8 were filled: $61.23 committed.
 *
 * The issue gives the totals, not each order, and the hosted chain is not reachable from here. The
 * spots and NO prices below are the ones that make the planner produce exactly those two totals, so
 * the fixture is a state the real routine could have left.
 */
import type { Ladder } from "@mandate/gemini";
import type { RecordedIntent } from "../src/index";
import { rung } from "./helpers";

export const ISSUE_88_TICKER = "BTC2611202200";
export const ISSUE_88_GOAL = { floorCents: 6_300_000 } as const;
export const ISSUE_88_HOLDING = { asset: "BTC", quantity: "0.05" } as const;
/** Spot at run 1 and at run 4. */
export const RUN_1_SPOT = 6_464_000;
export const RUN_4_SPOT = 6_466_000;

const STRIKES = [62_000, 62_500, 63_000, 63_500, 64_000, 64_500, 65_000, 65_500, 66_000];

/** The ladder with the NO prices one run saw for the four strikes it bought. */
export function issue88Ladder(spotCents: number, noPrices: Record<number, number>): Ladder {
  return {
    asset: "BTC",
    eventTicker: ISSUE_88_TICKER,
    title: "BTC price on November 20",
    kind: "weekly",
    expiry: "2026-11-20T22:00:00.000Z",
    settlementIndex: "LS-LRRR-XBTUSD",
    spot: {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: spotCents,
      askCents: spotCents,
      lastCents: spotCents,
      midCents: spotCents,
      fetchedAt: "2026-11-17T01:25:00.000Z",
    },
    rungs: STRIKES.map((k) =>
      rung(k, noPrices[k] ?? Math.max(1, Math.min(99, Math.round(50 - (k - spotCents / 100) / 50)))),
    ),
    fetchedAt: "2026-11-17T01:25:00.000Z",
  };
}

export const RUN_1_PRICES = { 64_500: 45, 64_000: 40, 63_500: 35, 63_000: 31 };
export const RUN_4_PRICES = { 64_500: 51, 64_000: 43, 63_500: 36, 63_000: 31 };

const symbol = (strike: number) => `GEMI-${ISSUE_88_TICKER}-HI${strike.toString()}`;

/** [strike, contracts in hundredths, NO price] of each order, in the order they were proposed. */
const ORDERS: [number, number, number][] = [
  // Run 1: spot $64,640, so the top rung covers $64,640 to $64,500 (7.00 contracts).
  [64_500, 700, 45],
  [64_000, 2_500, 40],
  [63_500, 2_500, 35],
  [63_000, 2_500, 31],
  // Run 4: spot $64,660, a full ladder again (8.00 contracts on top).
  [64_500, 800, 51],
  [64_000, 2_500, 43],
  [63_500, 2_500, 36],
  [63_000, 2_500, 31],
];

/** The eight intents as the contract records them after the executor filled each in full. */
export const ISSUE_88_INTENTS: RecordedIntent[] = ORDERS.map(([strike, hundredths, price], id) => {
  const amountCents = Math.ceil((hundredths * price) / 100);
  return {
    id,
    market: symbol(strike),
    outcome: "NO",
    isBuy: true,
    amountCents,
    limitPrice: price,
    status: "executed",
    filledCents: amountCents,
  };
});
