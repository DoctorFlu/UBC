import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Ladder } from "@mandate/gemini";
import {
  assessCover,
  COVER_TOLERANCE_BPS,
  hedgePayoutCents,
  HOLDING_SCALE,
  planHedge,
  positionsFromIntents,
  summarizePlan,
  symbolsMissingFromLadder,
  UnresolvedPositionError,
  type HedgeInput,
  type HedgePlan,
  type HeldPosition,
  type RecordedIntent,
} from "../src/index";
import { rung } from "./helpers";
import {
  ISSUE_88_GOAL,
  ISSUE_88_HOLDING,
  ISSUE_88_INTENTS,
  issue88Ladder,
  RUN_1_PRICES,
  RUN_1_SPOT,
  RUN_4_PRICES,
  RUN_4_SPOT,
} from "./issue-88";

/** The intents a plan's orders become once the contract approves each (status as given). */
function intentsOf(plan: HedgePlan, status = "approved", firstId = 0): RecordedIntent[] {
  return plan.orders.map((order, i) => ({
    id: firstId + i,
    market: order.instrumentSymbol,
    outcome: "NO",
    isBuy: true,
    amountCents: order.amountCents,
    limitPrice: order.limitPriceCents,
    status,
    filledCents: status === "executed" ? order.amountCents : null,
  }));
}

const LIMITS = { maxTradeCents: 1_000_000, remainingBudgetCents: 10_000_000, categoryAllowed: true };

function input(ladder: Ladder, held?: HeldPosition[], extra: Partial<HedgeInput> = {}): HedgeInput {
  return {
    holding: ISSUE_88_HOLDING,
    ladder,
    goal: ISSUE_88_GOAL,
    maxCostCents: 4_500,
    limits: LIMITS,
    ...(held === undefined ? {} : { held }),
    ...extra,
  };
}

describe("the hosted state from issue #88", () => {
  const run1Ladder = issue88Ladder(RUN_1_SPOT, RUN_1_PRICES);
  const run4Ladder = issue88Ladder(RUN_4_SPOT, RUN_4_PRICES);

  it("is the state the routine left: $29.65, then a full second ladder for $31.58", () => {
    const first = planHedge(input(run1Ladder));
    expect(first.totals.costCents).toBe(2_965);
    const second = planHedge(input(run4Ladder));
    expect(second.totals.costCents).toBe(3_158);
    const amounts = ISSUE_88_INTENTS.map((intent) => intent.amountCents ?? 0);
    expect(amounts.slice(0, 4)).toEqual(first.orders.map((o) => o.amountCents));
    expect(amounts.slice(4)).toEqual(second.orders.map((o) => o.amountCents));
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(6_123);
  });

  it("was already covered at run 4: run 1's fills alone are about 99%, within the tolerance", () => {
    const held = positionsFromIntents(ISSUE_88_INTENTS.slice(0, 4), run4Ladder);
    const plan = planHedge(input(run4Ladder, held));
    expect(plan.cover).toMatchObject({
      state: "met",
      measuredBelowCents: 6_300_000,
      targetPayoutCents: 8_300,
      heldPayoutCents: 8_200,
      shortfallCents: 100,
      toleranceCents: 166,
      coverBps: 9_879,
    });
    expect(plan.orders).toEqual([]);
    expect(plan.status).toBe("empty");
    expect(plan.warnings.map((w) => w.code)).toContain("already_covered");
  });

  it("reads all 8 fills as covered (about twice the goal) and plans no orders", () => {
    for (const spot of [RUN_1_SPOT, RUN_4_SPOT, 6_480_000, 6_420_000]) {
      const ladder = issue88Ladder(spot, RUN_4_PRICES);
      const held = positionsFromIntents(ISSUE_88_INTENTS, ladder);
      expect(held).toHaveLength(8);
      const plan = planHedge(input(ladder, held));
      expect(plan.cover?.state).toBe("met");
      expect(plan.cover?.heldByState).toEqual({ filled: 16_500, awaiting_fill: 0, awaiting_owner: 0 });
      expect(plan.orders).toEqual([]);
    }
    const plan = planHedge(input(run4Ladder, positionsFromIntents(ISSUE_88_INTENTS, run4Ladder)));
    expect(plan.cover?.coverBps).toBe(19_879);
    expect(summarizePlan(plan)).toBe(
      "The 0.05 BTC is already covered below $63,000: the contracts held pay $165.00 there ($165.00 filled), 198% of the $83.00 the goal calls for, so nothing more is bought. Spot is $64,660. No orders are needed.",
    );
  });
});

describe("cover against the goal's staircase", () => {
  const ladder = issue88Ladder(RUN_1_SPOT, RUN_1_PRICES);
  const full = planHedge(input(ladder));

  it("with nothing held is not met, and the plan is the full staircase with the same id", () => {
    const plan = planHedge(input(ladder, []));
    expect(plan.cover).toMatchObject({ state: "not_met", heldPayoutCents: 0, missingPayoutCents: 8_200 });
    expect(plan.orders).toEqual(full.orders);
    expect(plan.planId).toBe(full.planId);
    expect(full.cover).toBeUndefined();
  });

  it("counts filled, approved and held orders alike, and nothing rejected or failed", () => {
    const statuses = ["executed", "approved", "needs_approval", "rejected"];
    const intents = intentsOf(full).map((intent, i) => {
      const status = statuses[i] ?? "approved";
      return { ...intent, status, filledCents: status === "executed" ? intent.amountCents : null };
    });
    const held = positionsFromIntents(intents, ladder);
    expect(held.map((p) => [p.intentId, p.state])).toEqual([
      [0, "filled"],
      [1, "awaiting_fill"],
      [2, "awaiting_owner"],
    ]);
    const plan = planHedge(input(ladder, held));
    expect(plan.cover?.state).toBe("partly_met");
    // Only the rejected rung, at $63,000, is bought again.
    expect(plan.orders.map((o) => [o.instrumentSymbol, o.quantityHundredths])).toEqual([
      ["GEMI-BTC2611202200-HI63000", 2_500],
    ]);
    expect(plan.cover?.withPlanCoverBps).toBe(10_000);
    expect(summarizePlan(plan)).toContain("so this plan buys only the missing part");
  });

  it("buys only the top slice when spot rose past the tolerance", () => {
    const held = positionsFromIntents(intentsOf(full, "executed"), ladder);
    const risen = issue88Ladder(RUN_1_SPOT + 10_000, RUN_1_PRICES);
    const plan = planHedge(input(risen, held));
    expect(plan.cover).toMatchObject({ state: "partly_met", shortfallCents: 500, missingPayoutCents: 500 });
    expect(plan.orders.map((o) => [o.instrumentSymbol, o.quantityHundredths])).toEqual([
      ["GEMI-BTC2611202200-HI64500", 500],
    ]);
  });

  it("never sells: a fall in spot leaves the positions covering more than the goal", () => {
    const held = positionsFromIntents(intentsOf(full, "executed"), ladder);
    const fallen = issue88Ladder(RUN_1_SPOT - 30_000, RUN_1_PRICES);
    const cover = assessCover({ holding: ISSUE_88_HOLDING, ladder: fallen, goal: ISSUE_88_GOAL, held });
    expect(cover.state).toBe("met");
    expect(cover.coverBps).toBeGreaterThan(10_000);
  });

  it("measures below the first strike under a floor that is not a strike", () => {
    const cover = assessCover({
      holding: ISSUE_88_HOLDING,
      ladder,
      goal: { floorCents: 6_320_000 },
      held: positionsFromIntents(
        intentsOf(planHedge({ ...input(ladder), goal: { floorCents: 6_320_000 } })),
        ladder,
      ),
    });
    expect(cover).toMatchObject({ state: "met", measuredBelowCents: 6_300_000, targetPayoutCents: 7_200 });
  });

  it("has a tolerance of 2% of the target, rounded down, and none under 50 cents", () => {
    const at = (hundredths: number, quantity = "0.05") =>
      assessCover({
        holding: { asset: "BTC", quantity },
        ladder,
        goal: ISSUE_88_GOAL,
        held: [
          {
            instrumentSymbol: "GEMI-BTC2611202200-HI63000",
            strikeCents: 6_300_000,
            hundredths,
            state: "filled",
          },
        ],
      });
    // Target $82.00: tolerance $1.64.
    expect(at(8_200 - 164)).toMatchObject({ state: "met", toleranceCents: 164 });
    expect(at(8_200 - 165).state).toBe("partly_met");
    expect(at(0).state).toBe("not_met");
    // 0.0002 BTC: the target is 32 cents, so the tolerance is 0 and nothing held is never "met".
    expect(at(0, "0.0002")).toMatchObject({ state: "not_met", targetPayoutCents: 32, toleranceCents: 0 });
    expect(at(31, "0.0002").state).toBe("partly_met");
    expect(at(32, "0.0002").state).toBe("met");
  });

  it("ignores sells, YES, other ladders and numbers that do not fit", () => {
    const base: RecordedIntent = {
      id: 0,
      market: "GEMI-BTC2611202200-HI64000",
      outcome: "NO",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 40,
      status: "approved",
      filledCents: null,
    };
    const ignored: RecordedIntent[] = [
      { ...base, isBuy: false },
      { ...base, outcome: "YES" },
      { ...base, market: "GEMI-BTC2611272200-HI64000" },
      // On this ladder but sold, rejected or empty: not counted, so its strike is never needed.
      { ...base, market: "GEMI-BTC2611202200-HI64250", status: "rejected" },
      { ...base, amountCents: null },
      { ...base, limitPrice: 0 },
      { ...base, status: "failed" },
      { ...base, status: "executed", filledCents: 0 },
    ];
    expect(positionsFromIntents(ignored, ladder)).toEqual([]);
    // $10 at 40 cents buys 25.00 contracts; $10 at 30 cents buys 33.33.
    expect(
      positionsFromIntents([base, { ...base, id: 1, limitPrice: 30 }], ladder).map((p) => p.hundredths),
    ).toEqual([2_500, 3_333]);
  });

  describe("positions the ladder does not list (fills the simulated venue made on production)", () => {
    const base: RecordedIntent = {
      id: 0,
      market: "GEMI-BTC2611202200-HI64000",
      outcome: "NO",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 40,
      status: "executed",
      filledCents: 1_000,
    };
    // Production lists $64,250 on the same event; the venue's ladder (the sandbox's) does not.
    const ELSEWHERE = "GEMI-BTC2611202200-HI64250";
    const intents: RecordedIntent[] = [
      base,
      { ...base, id: 1, market: ELSEWHERE },
      { ...base, id: 2, market: "GEMI-BTC2611272200-HI99000" },
    ];

    it("names the held symbols on this event the ladder lacks, and nothing on other events", () => {
      expect(symbolsMissingFromLadder(intents, ladder)).toEqual([ELSEWHERE]);
      expect(symbolsMissingFromLadder([base], ladder)).toEqual([]);
    });

    it("counts them at the strike production lists, so a plan never buys the same cover twice", () => {
      const held = positionsFromIntents(intents, ladder, new Map([[ELSEWHERE, 6_425_000]]));
      expect(held.map((p) => [p.instrumentSymbol, p.strikeCents, p.hundredths])).toEqual([
        ["GEMI-BTC2611202200-HI64000", 6_400_000, 2_500],
        [ELSEWHERE, 6_425_000, 2_500],
      ]);
    });

    it("refuses, never drops, a held position whose strike nobody lists", () => {
      expect(() => positionsFromIntents(intents, ladder)).toThrow(UnresolvedPositionError);
      expect(() => positionsFromIntents(intents, ladder)).toThrow(
        "GEMI-BTC2611202200-HI64250 is held on this ladder, but neither the venue nor Gemini's production exchange lists the strike now",
      );
      // A strike for a symbol of another event is never taken from `elsewhere`.
      expect(
        positionsFromIntents(
          [{ ...base, market: "GEMI-BTC2611272200-HI99000" }],
          ladder,
          new Map([["GEMI-BTC2611272200-HI99000", 1]]),
        ),
      ).toEqual([]);
    });
  });

  it("says there is nothing to cover when the floor is not below spot", () => {
    const cover = assessCover({
      holding: ISSUE_88_HOLDING,
      ladder,
      goal: { floorCents: 6_500_000 },
      held: [],
    });
    expect(cover).toMatchObject({ state: "nothing_to_cover", targetPayoutCents: 0, rungs: [] });
  });
});

// ---------------------------------------------------------------- properties

interface Case {
  input: HedgeInput;
  /** Arbitrary positions on the ladder, before any plan. */
  held: HeldPosition[];
}

const STEPS = [5, 50, 250, 500, 1_000];

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    step: fc.constantFrom(...STEPS),
    baseSteps: fc.integer({ min: 2, max: 200 }),
    count: fc.integer({ min: 2, max: 16 }),
    prices: fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 16, maxLength: 16 }),
    spotPermille: fc.integer({ min: 0, max: 1_100 }),
    floorPermille: fc.integer({ min: 1, max: 1_200 }),
    units: fc.bigInt({ min: 1n, max: 500_000_000n }),
    held: fc.array(
      fc.record({
        index: fc.integer({ min: 0, max: 15 }),
        hundredths: fc.integer({ min: 0, max: 50_000 }),
        state: fc.constantFrom("filled" as const, "awaiting_fill" as const, "awaiting_owner" as const),
      }),
      { maxLength: 8 },
    ),
  })
  .map((g): Case => {
    const rungs = Array.from({ length: g.count }, (_, i) =>
      rung(g.baseSteps * g.step + i * g.step, g.prices[i] ?? 50),
    );
    const low = rungs[0]?.strikeCents ?? 100;
    const high = rungs.at(-1)?.strikeCents ?? 100;
    const width = Math.max(high - low, g.step * 100);
    const spotCents = Math.max(1, Math.round(low + (g.spotPermille * width) / 1_000));
    const floorCents = Math.max(
      1,
      Math.round(spotCents - (g.floorPermille * (spotCents - low + width / 2)) / 1_000),
    );
    const ladder: Ladder = {
      asset: "BTC",
      eventTicker: "BTC2611202200",
      title: "t",
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
    const quantity = `${(g.units / HOLDING_SCALE).toString()}.${(g.units % HOLDING_SCALE).toString().padStart(8, "0")}`;
    const held = g.held.flatMap(({ index, hundredths, state }) => {
      const r = rungs[index % rungs.length];
      return r === undefined
        ? []
        : [{ instrumentSymbol: r.instrumentSymbol, strikeCents: r.strikeCents, hundredths, state }];
    });
    return {
      input: {
        holding: { asset: "BTC", quantity },
        ladder,
        goal: { floorCents },
        maxCostCents: 1_000_000_000,
        limits: { maxTradeCents: 1_000_000_000, remainingBudgetCents: 1_000_000_000, categoryAllowed: true },
      },
      held,
    };
  });

const RUNS = { numRuns: 300 };
const PROPERTY_TIMEOUT = { timeout: 120_000 };

/** What positions plus a plan pay for a finish just below `price`. */
function payoutBelow(held: readonly HeldPosition[], plan: HedgePlan, price: number): number {
  const fromHeld = held.filter((p) => p.strikeCents >= price).reduce((sum, p) => sum + p.hundredths, 0);
  return fromHeld + hedgePayoutCents(plan.rungs, price - 1);
}

describe("cover invariants", PROPERTY_TIMEOUT, () => {
  it("is idempotent: planning again after a plan is executed buys nothing", () => {
    fc.assert(
      fc.property(caseArb, ({ input: base }) => {
        const first = planHedge({ ...base, held: [] });
        const held = positionsFromIntents(intentsOf(first, "executed"), base.ladder);
        const again = planHedge({ ...base, held });
        expect(again.orders).toEqual([]);
        expect(["met", "nothing_to_cover"]).toContain(again.cover?.state);
      }),
      RUNS,
    );
  });

  it("completes the goal from any partial execution with only the missing contracts", () => {
    fc.assert(
      fc.property(caseArb, fc.nat(), ({ input: base }, cut) => {
        const first = planHedge({ ...base, held: [] });
        const done = intentsOf(first, "executed").slice(0, cut % (first.orders.length + 1));
        const held = positionsFromIntents(done, base.ladder);
        const rest = planHedge({ ...base, held });
        const cover = rest.cover;
        if (cover === undefined || cover.measuredBelowCents === null) return;
        // Each strike buys at most what the staircase asks there, and the goal ends met.
        const designed = new Map(first.rungs.map((r) => [r.instrumentSymbol, r.designedHundredths]));
        for (const r of rest.rungs)
          expect(r.quantityHundredths).toBeLessThanOrEqual(designed.get(r.instrumentSymbol) ?? 0);
        const after = payoutBelow(held, rest, cover.measuredBelowCents);
        expect(after).toBeGreaterThanOrEqual(cover.targetPayoutCents - cover.toleranceCents);
      }),
      RUNS,
    );
  });

  it("never pushes the payout below the floor beyond the goal, whatever is held", () => {
    fc.assert(
      fc.property(caseArb, ({ input: base, held }) => {
        const plan = planHedge({ ...base, held });
        const cover = plan.cover;
        if (cover === undefined) throw new Error("a plan given positions carries cover");
        if (cover.measuredBelowCents === null) {
          expect(plan.orders).toEqual([]);
          return;
        }
        const before = cover.heldPayoutCents;
        const after = payoutBelow(held, plan, cover.measuredBelowCents);
        expect(after).toBe(cover.withPlanPayoutCents);
        expect(after).toBeLessThanOrEqual(Math.max(before, cover.targetPayoutCents));
        // A goal that is met buys nothing; one that is not is completed when nothing binds.
        if (cover.state === "met") expect(plan.orders).toEqual([]);
        else expect(after).toBe(cover.targetPayoutCents);
        // The plan alone still never pays more than the full staircase at any price.
        const staircase = planHedge(base).rungs;
        for (const r of base.ladder.rungs) {
          for (const price of [r.strikeCents - 1, r.strikeCents]) {
            expect(hedgePayoutCents(plan.rungs, price)).toBeLessThanOrEqual(
              hedgePayoutCents(staircase, price),
            );
          }
        }
      }),
      RUNS,
    );
  });

  it("is met exactly when the shortfall is within 2% of the target", () => {
    fc.assert(
      fc.property(caseArb, ({ input: base, held }) => {
        const cover = assessCover({ ...base, held });
        if (cover.state === "nothing_to_cover") return;
        const tolerance = Math.floor((cover.targetPayoutCents * COVER_TOLERANCE_BPS) / 10_000);
        expect(cover.toleranceCents).toBe(tolerance);
        expect(cover.state === "met").toBe(cover.targetPayoutCents - cover.heldPayoutCents <= tolerance);
        expect(cover.state === "not_met").toBe(
          cover.heldPayoutCents === 0 && cover.targetPayoutCents > tolerance,
        );
      }),
      RUNS,
    );
  });

  it("never asks for more when more is held", () => {
    fc.assert(
      fc.property(
        caseArb,
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 1, max: 50_000 }),
        (c, index, extra) => {
          const r = c.input.ladder.rungs[index % c.input.ladder.rungs.length];
          if (r === undefined) return;
          const more = [
            ...c.held,
            {
              instrumentSymbol: r.instrumentSymbol,
              strikeCents: r.strikeCents,
              hundredths: extra,
              state: "filled" as const,
            },
          ];
          const before = assessCover({ ...c.input, held: c.held });
          const after = assessCover({ ...c.input, held: more });
          expect(after.heldPayoutCents).toBeGreaterThanOrEqual(before.heldPayoutCents);
          expect(after.missingPayoutCents).toBeLessThanOrEqual(before.missingPayoutCents);
        },
      ),
      RUNS,
    );
  });

  it("agrees with planHedge on the goal and the target", () => {
    fc.assert(
      fc.property(caseArb, ({ input: base, held }) => {
        const plan = planHedge({ ...base, held });
        const cover = assessCover({ ...base, held });
        const {
          withPlanPayoutCents: _a,
          withPlanCoverBps: _b,
          ...measured
        } = plan.cover ?? {
          withPlanPayoutCents: 0,
          withPlanCoverBps: null,
        };
        expect(measured).toEqual(cover);
        expect(cover.ceilingCents).toBe(plan.ceilingCents);
        expect(cover.floorCents).toBe(plan.floorCents);
      }),
      RUNS,
    );
  });
});
