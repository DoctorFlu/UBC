import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLadder, eventSchema, normalizeEvent } from "@mandate/gemini";
import { describe, expect, it } from "vitest";
import { hedgePayoutCents, planHedge, PlannerInputError, summarizePlan } from "../src/index";
import { EXAMPLE_SPOT, exampleInput, exampleLadder, rung } from "./helpers";

const codes = (plan: ReturnType<typeof planHedge>) => plan.warnings.map((w) => w.code);

describe("the design-doc worked example", () => {
  it("buys 25 NO at $65,500, $65,000, $64,500 and $64,000 for $40.75 with a $100 maximum payout", () => {
    const plan = planHedge(exampleInput());
    expect(
      plan.rungs.map((r) => [r.strikeCents / 100, r.quantity, r.limitPriceCents, r.amountCents]),
    ).toEqual([
      [65_500, "25.00", 48, 1_200],
      [65_000, "25.00", 43, 1_075],
      [64_500, "25.00", 38, 950],
      [64_000, "25.00", 34, 850],
    ]);
    expect(plan.orders).toHaveLength(4);
    expect(plan.totals).toMatchObject({
      costCents: 4_075,
      maxPayoutCents: 10_000,
      protectedRange: { fromCents: 6_600_000, toCents: 6_400_000 },
      lossAtFloorCents: 7_930,
      payoutBelowFloorCents: 10_000,
      coverageAtFloorBps: 12_610,
    });
    expect(plan.status).toBe("ok");
    // Starting protection one strike above spot is allowed, and the plan says what that means.
    expect(plan.warnings).toEqual([
      {
        code: "ceiling_above_spot",
        message:
          "Protection starts at $66,000, above spot ($65,586), so the payout can exceed the holding's actual loss by up to $20.70.",
        strikesCents: [],
      },
    ]);
  });

  it("reproduces from the recorded Gemini ladder fixture", () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../gemini/test/fixtures/event-BTC2611202200-2026-11-14.json",
    );
    const event = normalizeEvent(eventSchema.parse(JSON.parse(readFileSync(fixture, "utf8"))));
    const ladder = buildLadder(event, exampleLadder().spot, { fetchedAt: "2026-11-14T15:50:00.000Z" });
    if (ladder === null) throw new Error("fixture is not a ladder");
    const plan = planHedge(exampleInput({ ladder }));
    expect(plan.rungs.map((r) => [r.instrumentSymbol, r.quantityHundredths, r.limitPriceCents])).toEqual([
      ["GEMI-BTC2611202200-HI65500", 2_500, 48],
      ["GEMI-BTC2611202200-HI65000", 2_500, 43],
      ["GEMI-BTC2611202200-HI64500", 2_500, 38],
      ["GEMI-BTC2611202200-HI64000", 2_500, 34],
    ]);
    expect(plan.totals.costCents).toBe(4_075);
    expect(plan.totals.maxPayoutCents).toBe(10_000);
  });

  it("pays exactly at strike boundaries: NO at K pays below K, not at K", () => {
    const plan = planHedge(exampleInput());
    expect(hedgePayoutCents(plan.rungs, 6_400_000)).toBe(7_500);
    expect(hedgePayoutCents(plan.rungs, 6_399_999)).toBe(10_000);
    expect(hedgePayoutCents(plan.rungs, 6_550_000)).toBe(0);
    expect(hedgePayoutCents(plan.rungs, 6_549_999)).toBe(2_500);
    const at = (price: number) => plan.payoff.find((p) => p.priceCents === price);
    expect(at(6_400_000)).toEqual({
      priceCents: 6_400_000,
      unhedgedPnlCents: -7_930,
      hedgePnlCents: 7_500 - 4_075,
      netPnlCents: -7_930 + 7_500 - 4_075,
    });
    expect(at(6_399_999)?.hedgePnlCents).toBe(10_000 - 4_075);
    expect(at(EXAMPLE_SPOT)).toEqual({
      priceCents: EXAMPLE_SPOT,
      unhedgedPnlCents: 0,
      hedgePnlCents: -4_075,
      netPnlCents: -4_075,
    });
    const prices = plan.payoff.map((p) => p.priceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("states break-even points", () => {
    const plan = planHedge(exampleInput());
    // Cumulative payout: $25, $50 (>= $40.75) at $65,000.
    expect(plan.breakEven.paysForItselfBelowCents).toBe(6_500_000);
    // $40.75 / 0.05 BTC = $815 above spot.
    expect(plan.breakEven.netBreakEvenAboveCents).toBe(EXAMPLE_SPOT + 81_500);
    expect(plan.breakEven.notes[0]).toBe(
      "The hedge costs $40.75 and pays back at least that if BTC finishes below $65,000.",
    );
  });

  it("is deterministic", () => {
    expect(planHedge(exampleInput()).planId).toBe(planHedge(exampleInput()).planId);
    expect(planHedge(exampleInput()).planId).toMatch(/^plan_[0-9a-f]{16}$/);
    expect(planHedge(exampleInput({ maxCostCents: 3_000 })).planId).not.toBe(
      planHedge(exampleInput()).planId,
    );
  });
});

describe("protection range", () => {
  it("starts protection at spot by default, covering the holding's loss at the floor to the contract", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_400_000 } }));
    expect(plan.ceilingCents).toBe(EXAMPLE_SPOT);
    expect(plan.rungs.map((r) => [r.strikeCents / 100, r.quantity, r.amountCents])).toEqual([
      // 0.05 x ($65,586 - $65,500) = 4.30 contracts, rounded down to 4 whole contracts at 48 cents.
      [65_500, "4.00", 192],
      [65_000, "25.00", 1_075],
      [64_500, "25.00", 950],
      [64_000, "25.00", 850],
    ]);
    expect(plan.totals.costCents).toBe(3_067);
    // 79.30 contracts of loss down to the floor; whole contracts buy 79 of them.
    expect(plan.totals.maxPayoutCents).toBe(7_900);
    expect(plan.totals.lossAtFloorCents).toBe(7_930);
    expect(plan.totals.coverageAtFloorBps).toBe(9_962);
    expect(plan.warnings).toEqual([]);
    expect(plan.status).toBe("ok");
  });

  it("can start protection at a strike below spot", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_400_000, ceilingCents: 6_550_000 } }));
    expect(plan.rungs.map((r) => [r.strikeCents / 100, r.quantity])).toEqual([
      [65_000, "25.00"],
      [64_500, "25.00"],
      [64_000, "25.00"],
    ]);
    expect(plan.totals.costCents).toBe(2_875);
    expect(plan.totals.coverageAtFloorBps).toBe(9_457);
  });

  it("sizes the last rung for the slice down to a floor between strikes", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_420_000, ceilingCents: 6_550_000 } }));
    expect(plan.rungs.map((r) => [r.strikeCents / 100, r.quantity])).toEqual([
      [65_000, "25.00"],
      [64_500, "25.00"],
      // 0.05 x ($64,500 - $64,200) = 15 contracts, paid below $64,000.
      [64_000, "15.00"],
    ]);
    expect(plan.totals.maxPayoutCents).toBe(6_500);
  });

  it("turns a percent drop into a floor", () => {
    const plan = planHedge(exampleInput({ goal: { dropPercent: 1.5 } }));
    // $65,586 x 0.985 = $64,602.21
    expect(plan.floorCents).toBe(6_460_221);
    // 0.05 x ($65,586 - $64,602.21) = 49.19 contracts down to the floor, 29 of them above $65,000:
    // the last rung buys the 20 whole contracts left, carrying the fractions of the rungs above.
    expect(plan.rungs.at(-1)).toMatchObject({ strikeCents: 6_450_000, quantity: "20.00", contracts: 20 });
    expect(plan.totals.maxPayoutCents).toBe(4_900);
  });

  it("lowers a ceiling more than one strike above spot", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_400_000, ceilingCents: 6_700_000 } }));
    expect(plan.ceilingCents).toBe(6_600_000);
    expect(codes(plan)).toEqual(["ceiling_lowered", "ceiling_above_spot"]);
  });

  it("warns when the floor is below the lowest strike (no tail protection)", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_300_000, ceilingCents: 6_550_000 } }));
    expect(plan.rungs).toHaveLength(3);
    expect(plan.status).toBe("partial");
    expect(plan.uncovered).toEqual([
      {
        code: "no_tail_protection",
        fromCents: 6_400_000,
        toCents: 6_300_000,
        shortfallCents: 5_000,
        strikeCents: null,
      },
    ]);
    expect(plan.warnings[0]?.message).toBe(
      "The lowest strike is $64,000, so nothing protects the fall from there to the floor $63,000 (up to $50.00).",
    );
  });

  it("returns an empty plan when the floor is not below the ceiling", () => {
    const plan = planHedge(exampleInput({ goal: { floorCents: 6_560_000 } }));
    expect(plan.status).toBe("empty");
    expect(codes(plan)).toEqual(["floor_not_below_ceiling"]);
  });

  it("returns an empty plan when every strike is above spot", () => {
    const plan = planHedge(exampleInput({ spotCents: 6_300_000, goal: { floorCents: 6_000_000 } }));
    expect(plan.status).toBe("empty");
    expect(codes(plan)).toEqual(["no_strike_below_spot"]);
  });
});

describe("limits", () => {
  it("keeps rungs nearest spot when the cost cap binds, scaling one and dropping the rest", () => {
    const plan = planHedge(exampleInput({ maxCostCents: 3_000 }));
    expect(plan.rungs.map((r) => [r.strikeCents / 100, r.quantity])).toEqual([
      [65_500, "25.00"],
      [65_000, "25.00"],
      [64_500, "19.00"],
    ]);
    // $7.25 is left for $64,500 at 38 cents: 19 whole contracts, $7.22.
    expect(plan.totals.costCents).toBe(2_997);
    const warning = plan.warnings.find((w) => w.code === "cost_cap_reached");
    expect(warning?.message).toBe(
      "To stay within the cost cap of $30.00, rungs nearest spot were kept and the rest cut: $64,500 scaled to 19 of 25 contracts; $64,000 dropped.",
    );
    expect(plan.uncovered.filter((u) => u.code === "cost_cap_reached").map((u) => u.shortfallCents)).toEqual([
      600, 2_500,
    ]);
  });

  it("reports an exhausted policy budget when it is tighter than the cost cap", () => {
    const plan = planHedge(
      exampleInput({ limits: { maxTradeCents: 10_000, remainingBudgetCents: 2_000, categoryAllowed: true } }),
    );
    expect(plan.totals.costCents).toBeLessThanOrEqual(2_000);
    expect(plan.totals.spendCapCents).toBe(2_000);
    expect(codes(plan)).toContain("budget_exhausted");
    expect(codes(plan)).not.toContain("cost_cap_reached");
  });

  it("splits a rung larger than the per-trade limit into orders within it", () => {
    const plan = planHedge(
      exampleInput({ limits: { maxTradeCents: 500, remainingBudgetCents: 100_000, categoryAllowed: true } }),
    );
    const top = plan.rungs[0];
    // $5.00 buys 10 whole contracts at 48 cents.
    expect(top?.orders.map((o) => [o.quantity, o.contracts, o.amountCents])).toEqual([
      ["10.00", 10, 480],
      ["10.00", 10, 480],
      ["5.00", 5, 240],
    ]);
    for (const order of plan.orders) expect(order.amountCents).toBeLessThanOrEqual(500);
    expect(codes(plan)).toContain("orders_split");
    expect(plan.totals.maxPayoutCents).toBe(10_000);
  });

  it("caps a rung at the depth available at the best price", () => {
    const plan = planHedge(exampleInput({ depthHundredths: { "GEMI-BTC2611202200-HI65000": 1_000 } }));
    expect(plan.rungs.find((r) => r.strikeCents === 6_500_000)?.quantity).toBe("10.00");
    expect(plan.warnings.find((w) => w.code === "thin_depth")?.message).toBe(
      "The order book is too thin at $65,000 (10 of 25) contracts at the best price; only whole contracts are bought.",
    );
  });

  it("buys only the whole contracts a fractional depth holds", () => {
    const plan = planHedge(exampleInput({ depthHundredths: { "GEMI-BTC2611202200-HI65000": 1_050 } }));
    expect(plan.rungs.find((r) => r.strikeCents === 6_500_000)).toMatchObject({
      quantity: "10.00",
      contracts: 10,
    });
    expect(plan.uncovered.find((u) => u.code === "thin_depth")?.shortfallCents).toBe(1_500);
    expect(plan.warnings.find((w) => w.code === "thin_depth")?.message).toContain("(10.50 of 25)");
  });

  describe("whole contracts under a cost cap (issue #54)", () => {
    // The live run: 0.05 BTC from spot $65,426 to a $64,500 floor, $15.00 max cost. Before the fix
    // the plan bought 21.3 contracts at 42 cents ($8.95) and 12.87 at 47 cents ($6.05).
    const capped = (maxCostCents: number) =>
      planHedge(
        exampleInput({
          ladder: { ...exampleLadder(), rungs: [rung(64_500, 47), rung(65_000, 42)] },
          spotCents: 6_542_600,
          goal: { floorCents: 6_450_000 },
          maxCostCents,
        }),
      );

    it("sizes every order as whole contracts within the $15.00 cap", () => {
      const plan = capped(1_500);
      expect(
        plan.orders.map((o) => [
          o.strikeCents / 100,
          o.quantity,
          o.contracts,
          o.limitPriceCents,
          o.amountCents,
        ]),
      ).toEqual([
        [65_000, "21.00", 21, 42, 882],
        [64_500, "13.00", 13, 47, 611],
      ]);
      expect(plan.totals).toMatchObject({
        costCents: 1_493,
        maxPayoutCents: 3_400,
        payoutBelowFloorCents: 3_400,
      });
      // Payoff figures come from the whole-contract orders.
      expect(plan.payoff.find((p) => p.priceCents === 6_449_999)?.hedgePnlCents).toBe(3_400 - 1_493);
      expect(plan.warnings.find((w) => w.code === "cost_cap_reached")?.message).toBe(
        "To stay within the cost cap of $15.00, rungs nearest spot were kept and the rest cut: $64,500 scaled to 13 of 25 contracts.",
      );
    });

    it("drops a rung that cannot afford one contract, and says why", () => {
      const plan = capped(900);
      expect(plan.orders.map((o) => [o.strikeCents / 100, o.contracts, o.amountCents])).toEqual([
        [65_000, 21, 882],
      ]);
      expect(plan.warnings.find((w) => w.code === "cost_cap_reached")?.message).toBe(
        "To stay within the cost cap of $9.00, rungs nearest spot were kept and the rest cut: $64,500 dropped, because one contract there costs 47 cents and only $0.18 was left.",
      );
      expect(plan.uncovered.find((u) => u.code === "cost_cap_reached")?.shortfallCents).toBe(2_500);
    });

    it("carries thin slices down the staircase, and buys nothing for less than one contract", () => {
      // 0.001 BTC over $2,000 is 2 contracts: each $500 slice is half a contract, so every second
      // strike buys one.
      const small = planHedge(exampleInput({ holding: { asset: "BTC", quantity: "0.001" } }));
      expect(small.orders.map((o) => [o.strikeCents / 100, o.contracts])).toEqual([
        [65_000, 1],
        [64_000, 1],
      ]);
      expect(small.totals.maxPayoutCents).toBe(200);
      // 0.0003 BTC over $2,000 is 0.6 contracts: nothing to buy.
      const plan = planHedge(exampleInput({ holding: { asset: "BTC", quantity: "0.0003" } }));
      expect(plan.orders).toEqual([]);
      expect(plan.warnings.find((w) => w.code === "below_minimum")?.message).toBe(
        "The holding needs less than one whole contract at $65,500, $65,000, $64,500, $64,000, so nothing is bought there.",
      );
    });
  });

  it("uses depth carried on the ladder", () => {
    const ladder = exampleLadder({ 64_500: { depth: { noBuyHundredths: 500, yesBuyHundredths: 0 } } });
    const plan = planHedge(exampleInput({ ladder }));
    expect(plan.rungs.find((r) => r.strikeCents === 6_450_000)?.quantity).toBe("5.00");
  });

  it("skips rungs whose market is not open or has no NO offer", () => {
    const ladder = exampleLadder({ 65_000: { marketState: "post_only" }, 64_500: { noBuyCents: null } });
    const plan = planHedge(exampleInput({ ladder }));
    expect(plan.rungs.map((r) => r.strikeCents / 100)).toEqual([65_500, 64_000]);
    expect(codes(plan)).toEqual(expect.arrayContaining(["market_not_open", "no_price"]));
    expect(plan.uncovered.map((u) => [u.code, u.fromCents / 100, u.toCents / 100])).toEqual([
      ["market_not_open", 65_500, 65_000],
      ["no_price", 65_000, 64_500],
    ]);
  });

  it("adds slippage to the limit price", () => {
    const plan = planHedge(exampleInput({ slippageCents: 2 }));
    expect(plan.rungs.map((r) => r.limitPriceCents)).toEqual([50, 45, 40, 36]);
  });

  it("plans nothing when the category is not allowed", () => {
    const plan = planHedge(
      exampleInput({
        limits: { maxTradeCents: 10_000, remainingBudgetCents: 100_000, categoryAllowed: false },
      }),
    );
    expect(plan.status).toBe("empty");
    expect(plan.orders).toEqual([]);
    expect(codes(plan)).toEqual(["category_not_allowed"]);
    expect(summarizePlan(plan)).toBe(
      "No hedge is planned for your 0.05 BTC. The policy does not allow trading this market category, so no hedge is planned. Spot is $65,586.",
    );
  });
});

describe("input validation", () => {
  it.each([
    ["a zero quantity", { holding: { asset: "BTC", quantity: "0" } }],
    ["too many decimals", { holding: { asset: "BTC", quantity: "0.000000001" } }],
    ["an exponent", { holding: { asset: "BTC", quantity: "1e-3" } }],
    ["a different asset", { holding: { asset: "ETH", quantity: "1" } }],
    ["a fractional cost cap", { maxCostCents: 1.5 }],
    ["a negative cost cap", { maxCostCents: -1 }],
    ["a bad drop", { goal: { dropPercent: 150 } }],
    ["a drop with three decimals", { goal: { dropPercent: 1.234 } }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => planHedge(exampleInput(overrides))).toThrow(PlannerInputError);
  });

  it("accepts a numeric quantity", () => {
    expect(planHedge(exampleInput({ holding: { asset: "btc", quantity: 0.05 } })).totals.costCents).toBe(
      4_075,
    );
  });
});

describe("summarizePlan", () => {
  it("reads the worked example back in three to five sentences with exact numbers", () => {
    const summary = summarizePlan(planHedge(exampleInput()));
    expect(summary).toBe(
      [
        "To protect your 0.05 BTC (spot $65,586), buy 100 NO contracts across 4 strikes from $65,500 down to $64,000 for $40.75, settling Nov 20, 2026 22:00 UTC.",
        "If BTC finishes below $64,000, the hedge pays $100.00 against a $79.30 loss on the holding there (126% covered).",
        "The hedge pays back its cost if BTC finishes below $65,000; at or above $65,500 it expires worthless.",
        "Protection starts at $66,000, above spot ($65,586), so the payout can exceed the holding's actual loss by up to $20.70.",
      ].join(" "),
    );
  });

  it("mentions split orders and the binding limit", () => {
    const summary = summarizePlan(
      planHedge(
        exampleInput({
          goal: { floorCents: 6_400_000 },
          maxCostCents: 2_000,
          limits: { maxTradeCents: 500, remainingBudgetCents: 100_000, categoryAllowed: true },
        }),
      ),
    );
    const sentences = summary.split(/(?<=\.) /);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(5);
    expect(summary).toContain("To stay within the cost cap of $20.00");
    expect(summary).toMatch(/That is \d+ orders, each within the per-trade limit\./);
  });
});
