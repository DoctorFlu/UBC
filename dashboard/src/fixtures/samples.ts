/**
 * A hedge plan for fixtures, previews and tests (the fixture snapshot stores it as the agent's plan).
 *
 * It is not hand-written: the real planner (@mandate/planner) plans it from a recorded-shape
 * BTC ladder, so the numbers on screen are exactly what the agent would get for these quotes.
 */
import { type HedgePlan, planHedge } from "@mandate/planner";

type Ladder = Parameters<typeof planHedge>[0]["ladder"];

const SPOT_CENTS = 6_558_600;
const FETCHED_AT = "2026-11-15T13:24:30.000Z";

function rung(strike: number, noBuyCents: number) {
  return {
    strikeCents: strike * 100,
    instrumentSymbol: `GEMI-BTC2611202200-HI${strike.toString()}`,
    label: `$${strike.toLocaleString("en-US")} or above`,
    marketState: "open" as const,
    yesBidCents: 100 - noBuyCents,
    yesAskCents: 101 - noBuyCents,
    noBuyCents,
    noSellCents: noBuyCents - 1,
    lastTradeCents: null,
  };
}

export const sampleLadder: Ladder = {
  asset: "BTC",
  eventTicker: "BTC2611202200",
  title: "BTC price on November 20",
  kind: "weekly",
  expiry: "2026-11-20T22:00:00.000Z",
  settlementIndex: "LS-LRRR-XBTUSD",
  spot: {
    asset: "BTC",
    symbol: "btcusd",
    bidCents: SPOT_CENTS - 50,
    askCents: SPOT_CENTS + 50,
    lastCents: SPOT_CENTS,
    midCents: SPOT_CENTS,
    fetchedAt: FETCHED_AT,
  },
  rungs: [rung(62_000, 14), rung(63_000, 18), rung(64_000, 24), rung(65_000, 31), rung(66_000, 52)],
  fetchedAt: FETCHED_AT,
};

export const sampleHedgePlan: HedgePlan = planHedge({
  holding: { asset: "BTC", quantity: "0.05" },
  ladder: sampleLadder,
  goal: { floorCents: 6_200_000 },
  maxCostCents: 6_000,
  limits: { maxTradeCents: 2_500, remainingBudgetCents: 20_000, categoryAllowed: true },
});
