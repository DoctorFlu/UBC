import type { Ladder } from "@mandate/gemini";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hedgePayoutCents, HOLDING_SCALE, parseHoldingUnits, planHedge, type HedgeInput } from "../src/index";
import { rung } from "./helpers";

const STEPS = [1, 5, 50, 100, 250, 500, 1_000, 2_500];

interface Scenario {
  input: HedgeInput;
  /** True when no cost, budget, trade, depth or market limit can bind. */
  unconstrained: boolean;
}

const scenario: fc.Arbitrary<Scenario> = fc
  .record({
    step: fc.constantFrom(...STEPS),
    baseSteps: fc.integer({ min: 2, max: 200 }),
    count: fc.integer({ min: 1, max: 25 }),
    prices: fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 25, maxLength: 25 }),
    closed: fc.array(fc.boolean(), { minLength: 25, maxLength: 25 }),
    depths: fc.array(fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: undefined }), {
      minLength: 25,
      maxLength: 25,
    }),
    spotPermille: fc.integer({ min: -100, max: 1_100 }),
    units: fc.bigInt({ min: 1n, max: 2_000_000_000n }),
    floorPermille: fc.integer({ min: 1, max: 1_300 }),
    ceilingMode: fc.constantFrom("default", "spot", "above", "random"),
    ceilingPermille: fc.integer({ min: 0, max: 1_500 }),
    maxCostCents: fc.integer({ min: 0, max: 200_000 }),
    maxTradeCents: fc.integer({ min: 0, max: 50_000 }),
    remainingBudgetCents: fc.integer({ min: 0, max: 200_000 }),
    slippageCents: fc.integer({ min: 0, max: 5 }),
    unconstrained: fc.boolean(),
  })
  .map((g): Scenario => {
    const stepDollars = g.step;
    const base = g.baseSteps * stepDollars;
    const rungs = Array.from({ length: g.count }, (_, i) =>
      rung(base + i * stepDollars, g.prices[i] ?? 50, {
        marketState: !g.unconstrained && g.closed[i] === true && i % 3 === 0 ? "closed" : "open",
      }),
    );
    const low = rungs[0]?.strikeCents ?? 100;
    const high = rungs.at(-1)?.strikeCents ?? 100;
    const width = Math.max(high - low, stepDollars * 100);
    const spotCents = Math.max(1, Math.round(low + (g.spotPermille * width) / 1_000));
    const floorCents = Math.max(
      1,
      Math.round(spotCents - (g.floorPermille * (spotCents - low + width / 2)) / 1_000),
    );
    const ceilingCents =
      g.ceilingMode === "default"
        ? undefined
        : g.ceilingMode === "spot"
          ? spotCents
          : g.ceilingMode === "above"
            ? spotCents + stepDollars * 100
            : Math.max(
                1,
                Math.round(floorCents + (g.ceilingPermille * (spotCents - floorCents + 1)) / 1_000),
              );
    const ladder: Ladder = {
      asset: "BTC",
      eventTicker: "BTC2611202200",
      title: "BTC price on November 20",
      kind: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      settlementIndex: null,
      spot: {
        asset: "BTC",
        symbol: "btcusd",
        bidCents: spotCents,
        askCents: spotCents,
        lastCents: spotCents,
        midCents: spotCents,
        fetchedAt: "t",
      },
      rungs,
      fetchedAt: "t",
    };
    const depthHundredths: Record<string, number> = {};
    if (!g.unconstrained) {
      rungs.forEach((r, i) => {
        const depth = g.depths[i];
        if (depth !== undefined) depthHundredths[r.instrumentSymbol] = depth;
      });
    }
    const quantity = `${(g.units / HOLDING_SCALE).toString()}.${(g.units % HOLDING_SCALE).toString().padStart(8, "0")}`;
    return {
      unconstrained: g.unconstrained,
      input: {
        holding: { asset: "BTC", quantity },
        ladder,
        goal: ceilingCents === undefined ? { floorCents } : { floorCents, ceilingCents },
        maxCostCents: g.unconstrained ? 1_000_000_000 : g.maxCostCents,
        limits: {
          maxTradeCents: g.unconstrained ? 1_000_000_000 : g.maxTradeCents,
          remainingBudgetCents: g.unconstrained ? 1_000_000_000 : g.remainingBudgetCents,
          categoryAllowed: true,
        },
        depthHundredths,
        slippageCents: g.slippageCents,
      },
    };
  });

/** Prices worth checking: every strike, one cent either side, the floor, ceiling, spot and extremes. */
function probePrices(s: Scenario, plan: ReturnType<typeof planHedge>): number[] {
  const prices = new Set<number>([0, 1, plan.spotCents, Number.MAX_SAFE_INTEGER]);
  for (const r of s.input.ladder.rungs) for (const d of [-1, 0, 1]) prices.add(r.strikeCents + d);
  for (const p of [plan.floorCents, plan.ceilingCents]) {
    if (p !== null) for (const d of [-1, 0, 1]) prices.add(p + d);
  }
  return [...prices].filter((p) => p >= 0).sort((a, b) => a - b);
}

const RUNS = { numRuns: 400 };

describe("hedge planner invariants", () => {
  it("never spends more than the cost cap or the remaining budget", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planHedge(s.input);
        const spent = plan.orders.reduce((sum, o) => sum + o.amountCents, 0);
        expect(plan.totals.costCents).toBe(spent);
        expect(spent).toBeLessThanOrEqual(s.input.maxCostCents);
        expect(spent).toBeLessThanOrEqual(s.input.limits.remainingBudgetCents);
      }),
      RUNS,
    );
  });

  it("keeps every order within maxTradeCents, on the 0.01 increment, priced exactly", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planHedge(s.input);
        for (const order of plan.orders) {
          expect(order.amountCents).toBeLessThanOrEqual(s.input.limits.maxTradeCents);
          expect(Number.isInteger(order.quantityHundredths)).toBe(true);
          expect(order.quantityHundredths).toBeGreaterThanOrEqual(1);
          expect(order.quantity).toMatch(/^\d+\.\d{2}$/);
          expect(Math.round(Number(order.quantity) * 100)).toBe(order.quantityHundredths);
          expect(order.amountCents).toBe(Math.ceil((order.quantityHundredths * order.limitPriceCents) / 100));
          expect(order.limitPriceCents).toBeGreaterThanOrEqual(1);
          expect(order.limitPriceCents).toBeLessThanOrEqual(99);
        }
        for (const r of plan.rungs) {
          expect(r.orders.reduce((sum, o) => sum + o.quantityHundredths, 0)).toBe(r.quantityHundredths);
          expect(r.quantityHundredths).toBeLessThanOrEqual(r.designedHundredths);
        }
      }),
      RUNS,
    );
  });

  it("never over-hedges: payout(P) <= q x (ceiling - max(P, floor)) at every price", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planHedge(s.input);
        if (plan.ceilingCents === null || plan.floorCents === null) {
          expect(plan.orders).toEqual([]);
          return;
        }
        const units = parseHoldingUnits(s.input.holding.quantity);
        for (const price of probePrices(s, plan)) {
          const payoutScaled = BigInt(hedgePayoutCents(plan.rungs, price)) * HOLDING_SCALE;
          const protectedLoss = plan.ceilingCents - Math.max(price, plan.floorCents);
          const bound = protectedLoss > 0 ? units * BigInt(protectedLoss) : 0n;
          expect(payoutScaled <= bound).toBe(true);
        }
        // With the default ceiling (at or below spot) that is also the holding's actual loss.
        if (plan.ceilingCents <= plan.spotCents) {
          expect(plan.warnings.map((w) => w.code)).not.toContain("ceiling_above_spot");
        }
        // The ceiling is never more than one strike above spot.
        const firstAbove = s.input.ladder.rungs.find((r) => r.strikeCents >= plan.spotCents)?.strikeCents;
        expect(plan.ceilingCents).toBeLessThanOrEqual(firstAbove ?? plan.spotCents);
      }),
      RUNS,
    );
  });

  it("has a hedge payoff that is non-negative and non-increasing in the final price", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planHedge(s.input);
        let previous = Number.POSITIVE_INFINITY;
        for (const price of probePrices(s, plan)) {
          const payout = hedgePayoutCents(plan.rungs, price);
          expect(payout).toBeGreaterThanOrEqual(0);
          expect(payout).toBeLessThanOrEqual(previous);
          previous = payout;
        }
        let curvePrevious = Number.POSITIVE_INFINITY;
        for (const point of plan.payoff) {
          const payout = point.hedgePnlCents + plan.totals.costCents;
          expect(payout).toBeGreaterThanOrEqual(0);
          expect(payout).toBeLessThanOrEqual(curvePrevious);
          expect(point.netPnlCents).toBe(point.unhedgedPnlCents + point.hedgePnlCents);
          curvePrevious = payout;
        }
      }),
      RUNS,
    );
  });

  it("bounds the net loss between ceiling and floor to one strike step when nothing binds", () => {
    fc.assert(
      fc.property(
        scenario.filter((s) => s.unconstrained),
        (s) => {
          const plan = planHedge(s.input);
          const range = plan.totals.protectedRange;
          if (range === null || plan.ceilingCents === null) return;
          const units = parseHoldingUnits(s.input.holding.quantity);
          const maxGap = Math.max(...plan.rungs.map((r) => r.coversFromCents - r.coversToCents));
          const aboveCeiling = Math.max(0, plan.spotCents - plan.ceilingCents);
          // Each rung rounds down by under 0.01 contract, which is under one cent of payout.
          const slack = BigInt(s.input.ladder.rungs.length) * HOLDING_SCALE;
          const bound = -(units * BigInt(aboveCeiling + maxGap)) - slack;
          for (const price of probePrices(s, plan)) {
            if (price < range.toCents || price > plan.ceilingCents) continue;
            const netBeforeCost =
              units * BigInt(price - plan.spotCents) +
              BigInt(hedgePayoutCents(plan.rungs, price)) * HOLDING_SCALE;
            expect(netBeforeCost >= bound).toBe(true);
          }
          // Below the protected range the payout is the whole designed protection.
          const designed = plan.rungs.reduce((sum, r) => sum + r.designedHundredths, 0);
          const lowestStrike = Math.min(...plan.rungs.map((r) => r.strikeCents));
          expect(hedgePayoutCents(plan.rungs, lowestStrike - 1)).toBe(designed);
        },
      ),
      RUNS,
    );
  });

  it("exercises real plans, not just empty ones", () => {
    const plans = fc.sample(scenario, { numRuns: 500, seed: 7 }).map((s) => planHedge(s.input));
    const seen = (code: string) => plans.filter((p) => p.warnings.some((w) => w.code === code)).length;
    expect(plans.filter((p) => p.orders.length > 0).length).toBeGreaterThan(150);
    for (const code of [
      "cost_cap_reached",
      "budget_exhausted",
      "orders_split",
      "thin_depth",
      "no_tail_protection",
    ]) {
      expect(seen(code)).toBeGreaterThan(5);
    }
  });

  it("plans nothing when the category is not allowed", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planHedge({ ...s.input, limits: { ...s.input.limits, categoryAllowed: false } });
        expect(plan.orders).toEqual([]);
        expect(plan.status).toBe("empty");
      }),
      { numRuns: 50 },
    );
  });
});

describe("hedge planner invariants with a paid signal", () => {
  const withSignal = fc
    .tuple(
      scenario,
      fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 25, maxLength: 25 }),
      fc.integer({ min: 0, max: 1_000 }),
    )
    .map(([s, probabilities, fairBandBps]) => ({
      s,
      signal: {
        receiptId: `0x${"ab".repeat(32)}`,
        signal: {
          signalId: `0x${"cd".repeat(32)}`,
          asset: "BTC",
          eventTicker: s.input.ladder.eventTicker,
          model: { fairBandBps },
          strikes: s.input.ladder.rungs.map((r, i) => ({
            strikeCents: r.strikeCents,
            modelYesBps: probabilities[i] ?? 5_000,
          })),
        },
      },
    }));

  it("keeps every limit and never over-hedges, whatever the signal says", () => {
    fc.assert(
      fc.property(withSignal, ({ s, signal }) => {
        const plan = planHedge({ ...s.input, signal });
        const baseline = planHedge(s.input);
        expect(plan.signal?.used).toBe(true);
        expect(plan.totals.costCents).toBeLessThanOrEqual(
          Math.min(s.input.maxCostCents, s.input.limits.remainingBudgetCents),
        );
        for (const order of plan.orders)
          expect(order.amountCents).toBeLessThanOrEqual(s.input.limits.maxTradeCents);
        // The staircase is the same; the signal only changes which rungs a binding cap cuts.
        expect(plan.ceilingCents).toBe(baseline.ceilingCents);
        expect(plan.floorCents).toBe(baseline.floorCents);
        const strikes = plan.rungs.map((r) => r.strikeCents);
        expect(strikes).toEqual([...strikes].sort((a, b) => b - a));
        if (plan.ceilingCents === null || plan.floorCents === null) {
          expect(plan.orders).toEqual([]);
          return;
        }
        const units = parseHoldingUnits(s.input.holding.quantity);
        for (const price of probePrices(s, plan)) {
          const payoutScaled = BigInt(hedgePayoutCents(plan.rungs, price)) * HOLDING_SCALE;
          const protectedLoss = plan.ceilingCents - Math.max(price, plan.floorCents);
          expect(payoutScaled <= (protectedLoss > 0 ? units * BigInt(protectedLoss) : 0n)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("changes nothing about the orders when no limit binds", () => {
    fc.assert(
      fc.property(
        withSignal.filter(({ s }) => s.unconstrained),
        ({ s, signal }) => {
          const plan = planHedge({ ...s.input, signal });
          expect(plan.orders).toEqual(planHedge(s.input).orders);
          expect(plan.signal?.changedOrders).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
