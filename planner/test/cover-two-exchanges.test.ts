import type { Ladder, LadderRung } from "@mandate/gemini";
import {
  HOSTED_INTENTS,
  HOSTED_WEEKLY_PLAN,
  LISTED,
  WEEKLY,
  WEEKLY_EXPIRY,
} from "@mandate/gemini/two-exchanges";
import { describe, expect, it } from "vitest";

import { assessCover, coverOfPlan, planHedge, positionsFromIntents } from "../src";

/**
 * Cover when the exchange orders go to lists other strikes than the one the positions were bought on
 * (18 November 2026: Gemini's sandbox lists HI67000 to HI70500 on the weekly, production HI61000 to
 * HI71000, and the hosted mandate held NO at HI61000 to HI64000). What is covered comes from the
 * positions held; what can be added, from the venue's own strikes.
 */

const SPOT = 6_469_037;
const FLOOR = HOSTED_WEEKLY_PLAN.plan.floorCents ?? 0;
const symbol = (strike: number) => `GEMI-${WEEKLY}-HI${String(strike)}`;

function rung(strike: number, noBuyCents: number | null): LadderRung {
  return {
    strikeCents: strike * 100,
    instrumentSymbol: symbol(strike),
    label: `$${strike.toLocaleString("en-US")} or above`,
    marketState: "open",
    yesBidCents: noBuyCents === null ? null : 100 - noBuyCents - 2,
    yesAskCents: noBuyCents === null ? null : 100 - noBuyCents,
    noBuyCents,
    noSellCents: noBuyCents === null ? null : noBuyCents - 2,
    lastTradeCents: null,
  };
}

function ladder(strikes: readonly number[], noBuyCents: number | null = null): Ladder {
  return {
    asset: "BTC",
    eventTicker: WEEKLY,
    title: "BTC price on November 20",
    kind: "weekly",
    expiry: WEEKLY_EXPIRY,
    settlementIndex: null,
    spot: {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: SPOT,
      askCents: SPOT,
      lastCents: SPOT,
      midCents: SPOT,
      fetchedAt: "2026-11-18T08:38:00.000Z",
    },
    rungs: strikes.map((strike) => rung(strike, noBuyCents)),
    fetchedAt: "2026-11-18T08:38:00.000Z",
  };
}

const sandboxWeekly = ladder(LISTED.sandbox[WEEKLY]);
const productionStrikes = new Map(LISTED.production[WEEKLY].map((strike) => [symbol(strike), strike * 100]));
const held = positionsFromIntents(HOSTED_INTENTS, sandboxWeekly, productionStrikes);
const goal = { floorCents: FLOOR };
const holding = { asset: "BTC", quantity: "0.05" };
const limits = { maxTradeCents: 2_500, remainingBudgetCents: 13_520, categoryAllowed: true };

describe("cover with positions at strikes the order venue does not list", () => {
  it("measures the goal by the positions held, on their own strikes", () => {
    const cover = assessCover({ holding, ladder: sandboxWeekly, goal, held });
    expect(cover).toMatchObject({
      state: "met",
      reason: null,
      floorCents: FLOOR,
      ceilingCents: SPOT,
      measuredBelowCents: 6_100_000,
      heldPayoutCents: 24_763,
    });
    // The same answer as on production, whose staircase also has HI64500 (nobody holds it): the same
    // target below $61,000, so the same cover.
    const onProduction = assessCover({ holding, ladder: ladder(LISTED.production[WEEKLY]), goal, held });
    const { rungs: _a, ...sandboxView } = cover;
    const { rungs: _b, ...productionView } = onProduction;
    expect(sandboxView).toEqual(productionView);
  });

  it("is the same through the plan, as the console and the digest read it", () => {
    const cover = coverOfPlan({
      plan: { ...HOSTED_WEEKLY_PLAN.plan, asset: "BTC" },
      holdingQuantity: "0.05",
      ladder: sandboxWeekly,
      spotCents: SPOT,
      intents: HOSTED_INTENTS,
      elsewhere: productionStrikes,
    });
    expect(cover?.assessment).toMatchObject({ state: "met", heldPayoutCents: 24_763 });
  });

  it("cannot be hedged when nothing is held and the venue lists no strike below spot", () => {
    const cover = assessCover({ holding, ladder: sandboxWeekly, goal, held: [] });
    expect(cover).toMatchObject({
      state: "cannot_hedge",
      reason: "no_strike_below_spot",
      floorCents: FLOOR,
      ceilingCents: null,
      measuredBelowCents: null,
    });
  });

  it("says the venue does not list the ladder, when it does not and nothing is held", () => {
    const cover = assessCover({ holding, ladder: { ...ladder([]), listed: false }, goal, held: [] });
    expect(cover).toMatchObject({ state: "cannot_hedge", reason: "ladder_not_listed", floorCents: FLOOR });
    // With positions held, they are the goal's measure even so.
    const measured = assessCover({ holding, ladder: { ...ladder([]), listed: false }, goal, held });
    expect(measured).toMatchObject({ state: "met", heldPayoutCents: 24_763 });
  });

  it("keeps each cause apart: floor not below spot, and a holding too small", () => {
    const above = assessCover({ holding, ladder: sandboxWeekly, goal: { floorCents: SPOT + 100 }, held });
    expect(above).toMatchObject({ state: "nothing_to_cover", reason: "floor_not_below_ceiling" });
    const tiny = assessCover({
      holding: { asset: "BTC", quantity: "0.00000001" },
      ladder: ladder(LISTED.production[WEEKLY]),
      goal,
      held: [],
    });
    expect(tiny).toMatchObject({ state: "cannot_hedge", reason: "holding_too_small" });
  });
});

describe("planHedge with positions at strikes the order venue does not list", () => {
  it("buys nothing on the sandbox weekly, and says the positions held already cover the goal", () => {
    const plan = planHedge({
      holding,
      ladder: sandboxWeekly,
      goal,
      maxCostCents: 6_000,
      limits,
      held,
    });
    expect(plan.orders).toEqual([]);
    expect(plan.cover).toMatchObject({ state: "met", heldPayoutCents: 24_763 });
    expect(plan.warnings.map((w) => w.code)).toContain("already_covered");
  });

  it("buys only on the venue's strikes to complete a goal the positions held cover in part", () => {
    // Half of the hosted positions held, and a venue that lists a few strikes below spot, priced.
    const venue = ladder([62000, 63000, 64000, 67000, 68000], 30);
    const half = held.filter((p) => p.intentId % 2 === 0);
    const plan = planHedge({ holding, ladder: venue, goal, maxCostCents: 100_000, limits, held: half });
    expect(plan.cover?.state).toBe("partly_met");
    const listed = new Set(venue.rungs.map((r) => r.instrumentSymbol));
    expect(plan.orders.length).toBeGreaterThan(0);
    for (const order of plan.orders) expect(listed.has(order.instrumentSymbol)).toBe(true);
  });
});
