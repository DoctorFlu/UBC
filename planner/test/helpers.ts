import type { Ladder, LadderRung } from "@mandate/gemini";
import type { HedgeInput } from "../src/index";

/** BTC spot when the design-doc example was priced (2026-11-14). */
export const EXAMPLE_SPOT = 6_558_600;

/** NO buy prices from the recorded 2026-11-14 BTC weekly ladder (BTC2611202200). */
const EXAMPLE_NO_PRICES: Record<number, number> = {
  64_000: 34,
  64_500: 38,
  65_000: 43,
  65_500: 48,
  66_000: 53,
  66_500: 58,
  67_000: 63,
};

export function rung(strikeDollars: number, noBuyCents: number, extra: Partial<LadderRung> = {}): LadderRung {
  return {
    strikeCents: strikeDollars * 100,
    instrumentSymbol: `GEMI-BTC2611202200-HI${strikeDollars.toString()}`,
    label: `$${strikeDollars.toLocaleString("en-US")} or above`,
    marketState: "open",
    yesBidCents: 100 - noBuyCents,
    yesAskCents: 100 - noBuyCents + 5,
    noBuyCents,
    noSellCents: noBuyCents - 4,
    lastTradeCents: null,
    ...extra,
  };
}

export function exampleLadder(overrides: Partial<Record<number, Partial<LadderRung>>> = {}): Ladder {
  return {
    asset: "BTC",
    eventTicker: "BTC2611202200",
    title: "BTC price on November 20",
    kind: "weekly",
    expiry: "2026-11-20T22:00:00.000Z",
    settlementIndex: "LS-LRRR-XBTUSD",
    spot: {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: EXAMPLE_SPOT,
      askCents: EXAMPLE_SPOT,
      lastCents: EXAMPLE_SPOT,
      midCents: EXAMPLE_SPOT,
      fetchedAt: "2026-11-14T15:50:00.000Z",
    },
    rungs: Object.entries(EXAMPLE_NO_PRICES).map(([strike, price]) =>
      rung(Number(strike), price, overrides[Number(strike)] ?? {}),
    ),
    fetchedAt: "2026-11-14T15:50:00.000Z",
  };
}

/** The design-doc example: 0.05 BTC, protected from $66,000 (the strike above spot) to $64,000. */
export function exampleInput(overrides: Partial<HedgeInput> = {}): HedgeInput {
  return {
    holding: { asset: "BTC", quantity: "0.05" },
    ladder: exampleLadder(),
    goal: { floorCents: 6_400_000, ceilingCents: 6_600_000 },
    maxCostCents: 4_500,
    limits: { maxTradeCents: 10_000, remainingBudgetCents: 100_000, categoryAllowed: true },
    ...overrides,
  };
}
