import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Ladder, LadderRung } from "@mandate/gemini";
import { type DecisionContext, verifyContext } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { type HedgeInput, type HedgePlan, planHedge } from "../src";
import { GOLDEN_CASES } from "./golden-cases";
import { exampleInput, exampleLadder } from "./helpers";
import { fixtureLadder } from "./two-exchange-ladders";

/**
 * Slippage buys depth: a plan may pay up to `slippageCents` above a rung's NO price, takes the book's levels
 * within it cheapest first, and its limit is the deepest level used. Read on the daily's book as it stood
 * at 12:39:48 UTC on 18 November 2026 (`DAILY_1239_NO_OFFERS`), thin at the top and deep behind it.
 */

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/main-1ca2f48/plans.json", import.meta.url)), "utf8"),
) as Record<string, HedgePlan>;

/** A plan without the fields this change adds, and its `thin_depth` sentence cut to the one main gave. */
function asMainMadeIt(plan: HedgePlan, golden: HedgePlan): unknown {
  const { depthOptions: _options, coversAtSlippageCents: _covers, ...rest } = plan;
  const { expectedFillCents: _fill, ...totals } = rest.totals;
  return {
    ...rest,
    totals,
    rungs: rest.rungs.map(
      ({ bestPriceCents: _best, levelsUsed: _levels, expectedFillCents: _expected, ...rung }) => rung,
    ),
    warnings: rest.warnings.map((warning, index) => {
      const before = golden.warnings[index]?.message ?? "";
      return warning.code === "thin_depth" && warning.message.startsWith(`${before} `)
        ? { ...warning, message: before }
        : warning;
    }),
  };
}

async function planOn(name: string, change: Partial<HedgeInput> = {}): Promise<HedgePlan> {
  const golden = GOLDEN_CASES.find((c) => c.name === name);
  if (golden === undefined) throw new Error(`no case ${name}`);
  const ladder = await fixtureLadder(golden.environment, golden.exchanges);
  return planHedge({ ...golden.input, ladder, ...change });
}

/** [strike in dollars, contracts, limit in cents, amount in cents] for every order. */
const orders = (plan: HedgePlan) =>
  plan.orders.map((o) => [o.strikeCents / 100, o.quantityHundredths / 100, o.limitPriceCents, o.amountCents]);

describe("at slippage 0, every plan is the one main made", () => {
  for (const c of GOLDEN_CASES) {
    it(c.name, async () => {
      const golden = GOLDEN[c.name];
      if (golden === undefined) throw new Error(`no golden plan for ${c.name}`);
      const plan = await planOn(c.name);
      // Same id, orders, quantities, limits, amounts and warnings; only the added fields and the added
      // sentences of `thin_depth` differ.
      expect(plan.planId).toBe(golden.planId);
      expect(plan.orders).toEqual(golden.orders);
      expect(plan.warnings.map((w) => [w.code, w.strikesCents])).toEqual(
        golden.warnings.map((w) => [w.code, w.strikesCents]),
      );
      expect(asMainMadeIt(plan, golden)).toEqual(golden);
    });
  }
});

describe("a reason main sealed", () => {
  it("still verifies, and names the plan the planner makes now from the same inputs", async () => {
    const sealed = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./fixtures/main-1ca2f48/decision-context.json", import.meta.url)),
        "utf8",
      ),
    ) as { hash: string; document: DecisionContext };
    expect(verifyContext(sealed.document, sealed.hash)).toBe(true);
    expect((await planOn("production 12:39, 0.05 BTC")).planId).toBe(sealed.document.planId);
  });
});

describe("0.05 BTC on production's 12:39 book (12.50 contracts a rung)", () => {
  it("at the best price buys 5 at $63,000 and $63,500, covers 80 %, and says 1 cent more covers it all", async () => {
    const plan = await planOn("production 12:39, 0.05 BTC");
    expect(orders(plan)).toEqual([
      [64_250, 12.5, 56, 700],
      [64_000, 12.5, 47, 588],
      [63_750, 12.5, 41, 513],
      [63_500, 5, 34, 170],
      [63_250, 12.5, 27, 338],
      [63_000, 5, 21, 105],
    ]);
    expect(plan.totals.coverageAtFloorBps).toBe(8_000);
    expect(plan.coversAtSlippageCents).toBe(1);
    expect(plan.depthOptions).toEqual([
      {
        slippageCents: 1,
        coverBps: 10_000,
        totalAmountCents: 2_852,
        expectedFillCents: 2_842,
        orderCount: 6,
        orderAmountsCents: [700, 588, 513, 438, 338, 275],
        shortStrikesCents: [],
        coversGoal: true,
      },
    ]);
    expect(plan.warnings.find((w) => w.code === "thin_depth")?.message).toBe(
      "The order book is too thin at $63,500 (5.00 of 12.50), $63,000 (5.00 of 12.50) contracts at the best price. At the best price this plan covers 80%. Paying up to 1 cent above the best price covers 100%, for $28.52 committed (about $28.42 expected).",
    );
  });

  it("at 1 cent takes the next level where it needs it, at its price, and the rest at the best price", async () => {
    const plan = await planOn("production 12:39, 0.05 BTC", { slippageCents: 1 });
    // $63,000: 5 at 21c and 7.50 of the 25 at 22c. $63,500: 5 at 34c and 7.50 at 35c. Every other rung is
    // covered by its top level, so its limit stays the best price, not best + 1.
    expect(orders(plan)).toEqual([
      [64_250, 12.5, 56, 700],
      [64_000, 12.5, 47, 588],
      [63_750, 12.5, 41, 513],
      [63_500, 12.5, 35, 438],
      [63_250, 12.5, 27, 338],
      [63_000, 12.5, 22, 275],
    ]);
    expect(plan.rungs.map((r) => [r.strikeCents / 100, r.levelsUsed, r.expectedFillCents])).toEqual([
      [64_250, 1, 700],
      [64_000, 1, 588],
      [63_750, 1, 513],
      [63_500, 2, 433],
      [63_250, 1, 338],
      [63_000, 2, 270],
    ]);
    expect(plan.status).toBe("ok");
    expect(plan.totals).toMatchObject({
      costCents: 2_852,
      expectedFillCents: 2_842,
      coverageAtFloorBps: 10_000,
    });
    expect(plan.depthOptions).toBeUndefined();
  });

  it("at 2 and 5 cents buys exactly what 1 cent buys: never more than the goal needs", async () => {
    const one = await planOn("production 12:39, 0.05 BTC", { slippageCents: 1 });
    for (const slippageCents of [2, 5, 10]) {
      const plan = await planOn("production 12:39, 0.05 BTC", { slippageCents });
      expect(orders(plan)).toEqual(orders(one));
    }
  });
});

describe("0.3 BTC on production's 12:39 book (75 contracts a rung)", () => {
  it("at the best price: thin at $63,000, $63,250 and $63,500, and 3 cents covers it all", async () => {
    const plan = await planOn("production 12:39, 0.3 BTC");
    expect(
      plan.depthOptions?.map((o) => [o.slippageCents, o.coverBps, o.totalAmountCents, o.shortStrikesCents]),
    ).toEqual([
      [1, 7_888, 14_839, [6_325_000, 6_300_000]],
      [2, 9_000, 16_339, [6_300_000]],
      [3, 10_000, 17_479, []],
    ]);
    expect(plan.coversAtSlippageCents).toBe(3);
  });

  it("at 1, 2 and 5 cents, sizes and limits as the levels give them", async () => {
    const at = async (slippageCents: number) =>
      orders(await planOn("production 12:39, 0.3 BTC", { slippageCents }));
    // $63,500: 5 at 34c and 70 at 35c. $63,750: 30 at 41c and 45 at 42c. Orders above $25 are split.
    const deep = [
      [64_250, 44.64, 56, 2_500],
      [64_250, 30.36, 56, 1_701],
      [64_000, 53.19, 47, 2_500],
      [64_000, 21.81, 47, 1_026],
      [63_750, 59.52, 42, 2_500],
      [63_750, 15.48, 42, 651],
      [63_500, 71.42, 35, 2_500],
      [63_500, 3.58, 35, 126],
    ];
    expect(await at(1)).toEqual([...deep, [63_250, 25, 27, 675], [63_000, 30, 22, 660]]);
    // $63,250: 25 at 27c and 50 at 29c.
    expect(await at(2)).toEqual([...deep, [63_250, 75, 29, 2_175], [63_000, 30, 22, 660]]);
    // $63,000: 5 at 21c, 25 at 22c and 45 at 24c.
    expect(await at(5)).toEqual([...deep, [63_250, 75, 29, 2_175], [63_000, 75, 24, 1_800]]);
  });

  it("never buys beyond what is offered within the slippage", async () => {
    const plan = await planOn("production 12:39, 0.3 BTC", { slippageCents: 1 });
    // Within 1 cent: $63,000 offers 5 + 25, $63,250 offers 25.
    expect(plan.rungs.filter((r) => r.strikeCents <= 6_325_000).map((r) => r.quantityHundredths)).toEqual([
      2_500, 3_000,
    ]);
    expect(plan.uncovered.filter((u) => u.code === "thin_depth").map((u) => u.shortfallCents)).toEqual([
      5_000, 4_500,
    ]);
  });

  it("a spending cap still binds: no option spends more than it", async () => {
    const plan = await planOn("production 12:39, 0.3 BTC", { maxCostCents: 15_000 });
    expect(plan.depthOptions?.every((o) => o.totalAmountCents <= 15_000)).toBe(true);
    expect(plan.coversAtSlippageCents).toBeNull();
    expect(plan.warnings.find((w) => w.code === "thin_depth")?.message).toContain(
      "no slippage up to 10 cents covers the goal within the spending cap.",
    );
  });
});

describe("the sandbox's book, capped as the maker quotes (100 contracts and $50 a level)", () => {
  it("0.3 BTC: the caps leave every level it needs, so the plan is production's", async () => {
    const capped = await planOn("sandbox capped 12:39, 0.3 BTC", { slippageCents: 5 });
    const production = await planOn("production 12:39, 0.3 BTC", { slippageCents: 5 });
    expect(orders(capped)).toEqual(orders(production));
  });

  it("0.5 BTC: where a capped level holds less, the plan takes the next one, and only as far as offered", async () => {
    const plan = await planOn("sandbox capped 12:39, 0.3 BTC", {
      holding: { asset: "BTC", quantity: "0.5" },
      maxCostCents: 50_000,
      slippageCents: 2,
    });
    // 125 a rung. $64,250: 100 at 56c (capped) and 25 of 100 at 58c. $63,000 within 2 cents: 5 + 25.
    const rung = (strike: number) => plan.rungs.find((r) => r.strikeCents === strike * 100);
    expect([rung(64_250)?.quantityHundredths, rung(64_250)?.limitPriceCents]).toEqual([12_500, 58]);
    expect([rung(63_000)?.quantityHundredths, rung(63_000)?.limitPriceCents]).toEqual([3_000, 22]);
  });
});

/** One rung of the example ladder with a book: [NO price, contracts] levels, cheapest first. */
function withBook(
  ladder: Ladder,
  strikeDollars: number,
  noBuyCents: number,
  levels: [number, number][],
): Ladder {
  return {
    ...ladder,
    rungs: ladder.rungs.map((r): LadderRung =>
      r.strikeCents !== strikeDollars * 100
        ? r
        : {
            ...r,
            noBuyCents,
            depth: {
              noBuyHundredths: (levels[0]?.[1] ?? 0) * 100,
              yesBuyHundredths: 0,
              noOffers: levels.map(([priceCents, contracts]) => ({
                priceCents,
                quantityHundredths: contracts * 100,
              })),
            },
          },
    ),
  };
}

describe("the listing's price and the book's best, read at different moments", () => {
  // The example plan wants 25 contracts at $65,000.
  const strike = 65_000;
  const rungOf = (plan: HedgePlan) => plan.rungs.find((r) => r.strikeCents === strike * 100);

  it("book one cent above the listing: at 0 the top at the listing's price, at 1 cent the book's levels", () => {
    const ladder = withBook(exampleLadder(), strike, 43, [
      [44, 10],
      [45, 100],
    ]);
    const zero = rungOf(planHedge(exampleInput({ ladder })));
    expect([zero?.quantityHundredths, zero?.limitPriceCents]).toEqual([1_000, 43]);
    const one = rungOf(planHedge(exampleInput({ ladder, slippageCents: 1 })));
    expect([one?.quantityHundredths, one?.limitPriceCents]).toEqual([1_000, 44]);
    const two = rungOf(planHedge(exampleInput({ ladder, slippageCents: 2 })));
    expect([two?.quantityHundredths, two?.limitPriceCents]).toEqual([2_500, 45]);
  });

  it("book one cent below the listing: at 0 the top at the listing's price, above 0 the book's own price", () => {
    const ladder = withBook(exampleLadder(), strike, 43, [
      [42, 10],
      [43, 100],
    ]);
    const zero = rungOf(planHedge(exampleInput({ ladder })));
    expect([zero?.quantityHundredths, zero?.limitPriceCents]).toEqual([1_000, 43]);
    // 10 at 42c and 15 at 43c: the limit is the deepest level used, the listing's price here.
    const one = rungOf(planHedge(exampleInput({ ladder, slippageCents: 1 })));
    expect([one?.quantityHundredths, one?.limitPriceCents, one?.expectedFillCents]).toEqual([
      2_500, 43, 1_065,
    ]);
  });

  it("a book whose top covers the rung: the limit falls back to its price, with no cushion", () => {
    const ladder = withBook(exampleLadder(), strike, 43, [[43, 100]]);
    const plan = planHedge(exampleInput({ ladder, slippageCents: 3 }));
    expect(rungOf(plan)?.limitPriceCents).toBe(43);
  });

  it("depth given by hand wins and is never walked: the limit is the price plus the slippage, as before", () => {
    const ladder = withBook(exampleLadder(), strike, 43, [
      [43, 10],
      [44, 100],
    ]);
    const plan = planHedge(
      exampleInput({ ladder, slippageCents: 2, depthHundredths: { "GEMI-BTC2611202200-HI65000": 1_000 } }),
    );
    expect([rungOf(plan)?.quantityHundredths, rungOf(plan)?.limitPriceCents]).toEqual([1_000, 45]);
    expect(plan.depthOptions).toEqual([]);
  });

  it("a one-level book (the sandbox maker's mirror today): walking finds nothing, and the plan says so", () => {
    const ladder = withBook(exampleLadder(), strike, 43, [[43, 10]]);
    const plan = planHedge(exampleInput({ ladder }));
    expect([rungOf(plan)?.quantityHundredths, rungOf(plan)?.limitPriceCents]).toEqual([1_000, 43]);
    expect(plan.depthOptions).toEqual([]);
    expect(plan.coversAtSlippageCents).toBeNull();
    expect(plan.warnings.find((w) => w.code === "thin_depth")?.message).toContain(
      "No more is offered within 10 cents of the best price.",
    );
  });
});

describe("what slippage never does", () => {
  it("buys only strikes the ladder lists, and never more than the goal at any slippage", async () => {
    const golden = GOLDEN_CASES.find((c) => c.name === "production 12:39, 0.3 BTC");
    if (golden === undefined) throw new Error("no case");
    const ladder = await fixtureLadder(golden.environment, golden.exchanges);
    const listed = new Set(ladder.rungs.map((r) => r.instrumentSymbol));
    for (let slippageCents = 0; slippageCents <= 10; slippageCents++) {
      const plan = planHedge({ ...golden.input, ladder, slippageCents });
      expect(plan.orders.every((o) => listed.has(o.instrumentSymbol))).toBe(true);
      for (const rung of plan.rungs)
        expect(rung.quantityHundredths).toBeLessThanOrEqual(rung.designedHundredths);
      for (const rung of plan.rungs)
        expect(rung.expectedFillCents ?? 0).toBeLessThanOrEqual(rung.amountCents);
      expect(plan.totals.costCents).toBeLessThanOrEqual(golden.input.maxCostCents);
    }
  });
});
