/**
 * Sample data for views whose real source lands in a later issue: the hedge ladder and payoff (#17)
 * and x402 payments (#22). Views that show these mark them "Sample data" on screen.
 *
 * The hedge plan is not hand-written: the real planner (@mandate/planner) plans it from a recorded-shape
 * BTC ladder, so the numbers on screen are exactly what the agent would get for these quotes.
 */
import { type HedgePlan, planHedge } from "@mandate/planner";
import type { Hex } from "viem";

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

export interface SamplePayment {
  id: string;
  at: string;
  item: string;
  provider: string;
  priceCents: number;
  settlementTx: Hex;
}

export const samplePayments: readonly SamplePayment[] = [
  {
    id: "pay-0003",
    at: "2026-11-15T13:24:21.000Z",
    item: "BTC implied volatility, 30 day",
    provider: "signals.example",
    priceCents: 5,
    settlementTx: "0x4246bf7d9b5481255a9b0c8d9752e90fa5bbca7e8952be641682a71c9bb10dc3",
  },
  {
    id: "pay-0002",
    at: "2026-11-15T13:24:18.000Z",
    item: "Funding rates, top 5 venues",
    provider: "signals.example",
    priceCents: 3,
    settlementTx: "0xf2fa238b6083c1097c6904eadab5584ba62bca4c77df09489558e124266b3553",
  },
  {
    id: "pay-0001",
    at: "2026-11-15T13:21:31.000Z",
    item: "Gemini order book snapshot",
    provider: "signals.example",
    priceCents: 2,
    settlementTx: "0x2e957a3574673bec0d4111bdb00f5e3bba82da87adb315c06edcc6ad2a870c96",
  },
];

export const samplePaymentsSummary = {
  spentTodayCents: 10,
  toolBudgetCents: 200,
  gatewayBalanceCents: 1_990,
};
