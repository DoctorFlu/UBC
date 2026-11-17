import { planHedge } from "@mandate/planner";

/** A three-rung BTC ladder, expiring at `expiry`. */
export function exampleLadder(expiry = "2026-11-20T22:00:00.000Z") {
  const eventTicker = `BTC${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}2200`;
  const rung = (strike: number, noBuyCents: number) => ({
    strikeCents: strike * 100,
    instrumentSymbol: `GEMI-${eventTicker}-HI${String(strike)}`,
    label: `$${strike.toLocaleString("en-US")} or above`,
    marketState: "open" as const,
    yesBidCents: 100 - noBuyCents,
    yesAskCents: 105 - noBuyCents,
    noBuyCents,
    noSellCents: noBuyCents - 4,
    lastTradeCents: null,
  });
  const spot = 6_558_600;
  return {
    asset: "BTC",
    eventTicker,
    title: "BTC price on expiry",
    kind: "weekly" as const,
    expiry,
    settlementIndex: "LS-LRRR-XBTUSD",
    spot: {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: spot,
      askCents: spot,
      lastCents: spot,
      midCents: spot,
      fetchedAt: "2026-11-14T15:50:00.000Z",
    },
    rungs: [rung(64_000, 34), rung(65_000, 43), rung(66_000, 53)],
    fetchedAt: "2026-11-14T15:50:00.000Z",
  };
}

export function examplePlan(expiry?: string) {
  return planHedge({
    holding: { asset: "BTC", quantity: "0.05" },
    ladder: exampleLadder(expiry),
    goal: { floorCents: 6_400_000, ceilingCents: 6_600_000 },
    maxCostCents: 4_500,
    limits: { maxTradeCents: 10_000, remainingBudgetCents: 100_000, categoryAllowed: true },
  });
}
