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

const productionStrikes = new Map(LISTED.production[WEEKLY].map((strike) => [symbol(strike), strike * 100]));
/** Production's strikes the sandbox lacks, as `MarketQuotes` and the agent read them. */
const elsewhere = LISTED.production[WEEKLY].filter(
  (strike) => !(LISTED.sandbox[WEEKLY] as readonly number[]).includes(strike),
).map((strike) => ({ instrumentSymbol: symbol(strike), strikeCents: strike * 100 }));
const sandboxWeekly = { ...ladder(LISTED.sandbox[WEEKLY]), elsewhere };
const productionWeekly = ladder(LISTED.production[WEEKLY]);
const held = positionsFromIntents(HOSTED_INTENTS, sandboxWeekly, productionStrikes);
/** The three highest strikes of the hosted positions only: HI64000, HI63500 and HI63000. */
const topThree = held.filter((p) => p.intentId <= 2);
const goal = { floorCents: FLOOR };
const holding = { asset: "BTC", quantity: "0.05" };
const limits = { maxTradeCents: 2_500, remainingBudgetCents: 13_520, categoryAllowed: true };
const plan = { ...HOSTED_WEEKLY_PLAN.plan, asset: "BTC" };

describe("cover with positions at strikes the order venue does not list", () => {
  it("measures the same goal as on production, rung for rung", () => {
    const cover = assessCover({ holding, ladder: sandboxWeekly, goal, held });
    expect(cover).toMatchObject({
      state: "met",
      reason: null,
      floorCents: FLOOR,
      ceilingCents: SPOT,
      measuredBelowCents: 6_100_000,
      targetPayoutCents: 18_451,
      heldPayoutCents: 24_763,
    });
    expect(cover).toEqual(assessCover({ holding, ladder: productionWeekly, goal, held }));
  });

  it("never sizes the goal by what is held", () => {
    const whole = assessCover({ holding, ladder: sandboxWeekly, goal, held });
    for (const [index] of held.entries()) {
      const without = assessCover({ holding, ladder: sandboxWeekly, goal, held: held.toSpliced(index, 1) });
      expect([without.targetPayoutCents, without.measuredBelowCents]).toEqual([
        whole.targetPayoutCents,
        whole.measuredBelowCents,
      ]);
    }
    const none = assessCover({ holding, ladder: sandboxWeekly, goal, held: [] });
    expect([none.targetPayoutCents, none.measuredBelowCents]).toEqual([18_451, 6_100_000]);
  });

  it("reads part of the goal held as partly covered, and says the venue can add nothing", () => {
    const cover = assessCover({ holding, ladder: sandboxWeekly, goal, held: topThree });
    expect(cover).toMatchObject({
      state: "partly_met",
      reason: "no_strike_below_spot",
      targetPayoutCents: 18_451,
      addablePayoutCents: 0,
    });
  });

  it("is the same through the plan, as the console and the digest read it", () => {
    const cover = coverOfPlan({
      plan,
      holdingQuantity: "0.05",
      ladder: sandboxWeekly,
      spotCents: SPOT,
      intents: HOSTED_INTENTS,
      elsewhere: new Map(elsewhere.map((s) => [s.instrumentSymbol, s.strikeCents])),
    });
    expect(cover?.assessment).toMatchObject({
      state: "met",
      heldPayoutCents: 24_763,
      targetPayoutCents: 18_451,
    });
  });

  it("cannot be hedged when nothing is held and the venue lists no strike below spot", () => {
    const cover = assessCover({ holding, ladder: sandboxWeekly, goal, held: [] });
    expect(cover).toMatchObject({
      state: "cannot_hedge",
      reason: "no_strike_below_spot",
      floorCents: FLOOR,
      heldPayoutCents: 0,
      addablePayoutCents: 0,
    });
  });

  it("says the venue does not list the ladder, when it does not and nothing is held", () => {
    const unlisted = {
      ...ladder([]),
      listed: false,
      elsewhere: [...productionStrikes].map(([instrumentSymbol, strikeCents]) => ({
        instrumentSymbol,
        strikeCents,
      })),
    };
    const cover = assessCover({ holding, ladder: unlisted, goal, held: [] });
    expect(cover).toMatchObject({ state: "cannot_hedge", reason: "ladder_not_listed", floorCents: FLOOR });
    // With positions held, they are measured against the same goal on production's strikes.
    const measured = assessCover({ holding, ladder: unlisted, goal, held });
    expect(measured).toMatchObject({ state: "met", heldPayoutCents: 24_763, targetPayoutCents: 18_451 });
    const part = assessCover({ holding, ladder: unlisted, goal, held: topThree });
    expect(part).toMatchObject({ state: "partly_met", reason: "ladder_not_listed", addablePayoutCents: 0 });
  });

  it("keeps each cause apart: floor not below spot, and a holding too small", () => {
    const above = assessCover({ holding, ladder: sandboxWeekly, goal: { floorCents: SPOT + 100 }, held });
    expect(above).toMatchObject({ state: "nothing_to_cover", reason: "floor_not_below_ceiling" });
    const tiny = assessCover({
      holding: { asset: "BTC", quantity: "0.00000001" },
      ladder: productionWeekly,
      goal,
      held: [],
    });
    expect(tiny).toMatchObject({ state: "cannot_hedge", reason: "holding_too_small" });
  });
});

describe("cover with the price at or below the floor", () => {
  const FALLEN = 5_700_000;
  const at = (intents: typeof HOSTED_INTENTS) =>
    coverOfPlan({
      plan,
      holdingQuantity: "0.05",
      ladder: sandboxWeekly,
      spotCents: FALLEN,
      intents,
      elsewhere: new Map(elsewhere.map((s) => [s.instrumentSymbol, s.strikeCents])),
    })?.assessment;

  it("measures what the positions pay if it settles there against the goal as planned", () => {
    // As planned: 0.05 BTC from the plan's $64,435.33 down to $61,000, in 0.01 contracts.
    expect(at(HOSTED_INTENTS)).toMatchObject({
      state: "met",
      reason: null,
      spotCents: FALLEN,
      targetPayoutCents: 17_176,
      heldPayoutCents: 24_763,
      missingPayoutCents: 0,
      belowFloor: { plannedSpotCents: 6_443_533, paysAtSpotCents: 24_763 },
    });
    expect(at(HOSTED_INTENTS.filter((intent) => intent.id <= 2))).toMatchObject({
      state: "partly_met",
      targetPayoutCents: 17_176,
    });
  });

  it("has nothing to protect when nothing is held", () => {
    expect(at([])).toMatchObject({
      state: "nothing_to_cover",
      reason: "floor_not_below_ceiling",
      belowFloor: null,
    });
  });
});

describe("planHedge with positions at strikes the order venue does not list", () => {
  it("buys nothing on the sandbox weekly, and says the positions held already cover the goal", () => {
    const plan = planHedge({
      holding,
      ladder: sandboxWeekly,
      elsewhere,
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
    const others = LISTED.production[WEEKLY].filter(
      (strike) => !([62000, 63000, 64000, 67000, 68000] as readonly number[]).includes(strike),
    );
    const half = held.filter((p) => p.intentId % 2 === 0);
    const plan = planHedge({
      holding,
      ladder: venue,
      elsewhere: others.map((strike) => ({ instrumentSymbol: symbol(strike), strikeCents: strike * 100 })),
      goal,
      maxCostCents: 100_000,
      limits,
      held: half,
    });
    expect(plan.cover).toMatchObject({ state: "partly_met", reason: null });
    const listed = new Set(venue.rungs.map((r) => r.instrumentSymbol));
    expect(plan.orders.length).toBeGreaterThan(0);
    for (const order of plan.orders) expect(listed.has(order.instrumentSymbol)).toBe(true);
  });

  it("buys nothing below the floor, and says what the positions held pay rather than nothing to protect", () => {
    const fallen = planHedge({
      holding,
      ladder: sandboxWeekly,
      elsewhere,
      spotCents: 5_700_000,
      goal,
      maxCostCents: 6_000,
      limits,
      held,
    });
    expect(fallen.orders).toEqual([]);
    const warning = fallen.warnings.find((w) => w.code === "floor_not_below_ceiling")?.message;
    expect(warning).toContain("at or below the floor");
    expect(warning).toContain("$247.63");
    expect(warning).not.toContain("nothing to protect");
  });
});
