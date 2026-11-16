import { describe, expect, it } from "vitest";
import { planHedge, PlannerInputError, summarizePlan, type HedgeInput, type PaidSignal } from "../src/index";
import { exampleInput } from "./helpers";

const RECEIPT = `0x${"ab".repeat(32)}`;
const SIGNAL_ID = `0x${"cd".repeat(32)}`;

/**
 * Model probabilities for the example ladder (NO prices 48, 43, 38, 34 cents at $65,500 to $64,000).
 * With a 2-cent band: $65,500 expensive (model NO 44.00 vs 48), $65,000 fair (43.00 vs 43),
 * $64,500 and $64,000 cheap (41.00 vs 38, 37.00 vs 34).
 */
function paidSignal(overrides: Partial<PaidSignal["signal"]> = {}): PaidSignal {
  return {
    receiptId: RECEIPT,
    signal: {
      signalId: SIGNAL_ID,
      asset: "BTC",
      eventTicker: "BTC2611202200",
      model: { fairBandBps: 200 },
      strikes: [
        { strikeCents: 6_400_000, modelYesBps: 6_300 },
        { strikeCents: 6_450_000, modelYesBps: 5_900 },
        { strikeCents: 6_500_000, modelYesBps: 5_700 },
        { strikeCents: 6_550_000, modelYesBps: 5_600 },
        { strikeCents: 6_600_000, modelYesBps: 5_000 },
      ],
      ...overrides,
    },
  };
}

const withSignal = (overrides: Partial<HedgeInput> = {}, signal = paidSignal()) =>
  planHedge(exampleInput({ ...overrides, signal }));

describe("planHedge without a signal", () => {
  it("is exactly the plan it always was", () => {
    const plan = planHedge(exampleInput());
    expect("signal" in plan).toBe(false);
    expect(planHedge(exampleInput({ signal: undefined }))).toEqual(plan);
    expect(summarizePlan(plan)).not.toContain("signal");
  });
});

describe("planHedge with a paid signal", () => {
  it("rates each rung against the price it would pay and says how the signal was used", () => {
    const plan = withSignal();
    expect(plan.signal).toMatchObject({
      receiptId: RECEIPT,
      signalId: SIGNAL_ID,
      used: true,
      ignoredBecause: null,
      buyOrder: "signal",
      changedOrders: false,
      expensiveBoughtStrikesCents: [6_550_000],
    });
    expect(
      plan.signal?.rungs.map((r) => [r.strikeCents, r.limitPriceCents, r.modelNoBps, r.edgeBps, r.rating]),
    ).toEqual([
      [6_550_000, 48, 4_400, -400, "expensive"],
      [6_500_000, 43, 4_300, 0, "fair"],
      [6_450_000, 38, 4_100, 300, "cheap"],
      [6_400_000, 34, 3_700, 300, "cheap"],
    ]);
    expect(plan.signal?.rungs.every((r) => r.boughtHundredths === 2_500)).toBe(true);
  });

  it("buys the same orders as without it when the spend cap covers every rung", () => {
    const plan = withSignal();
    const baseline = planHedge(exampleInput());
    expect(plan.orders).toEqual(baseline.orders);
    expect(plan.rungs).toEqual(baseline.rungs);
    expect(plan.totals).toEqual(baseline.totals);
  });

  it("flags expensive strikes it still buys", () => {
    const plan = withSignal();
    const warning = plan.warnings.find((w) => w.code === "signal_expensive");
    expect(warning).toEqual({
      code: "signal_expensive",
      message:
        "The paid signal rates protection at $65,500 as expensive (at least 2 cents a contract above its model value); the plan still buys it because it is part of the protection asked for.",
      strikesCents: [6_550_000],
    });
    // A flag is not a gap in the protection.
    expect(plan.status).toBe("ok");
  });

  it("buys the cheapest rungs first when the spend cap binds", () => {
    const baseline = planHedge(exampleInput({ maxCostCents: 2_000 }));
    expect(baseline.rungs.map((r) => [r.strikeCents, r.quantityHundredths])).toEqual([
      [6_550_000, 2_500],
      [6_500_000, 1_800],
    ]);

    const plan = withSignal({ maxCostCents: 2_000 });
    // $64,500 (950) and $64,000 (850) first, then 4 whole contracts at $65,000 with the 200 cents
    // left; $65,500 is cut.
    expect(plan.rungs.map((r) => [r.strikeCents, r.quantityHundredths, r.amountCents])).toEqual([
      [6_500_000, 400, 172],
      [6_450_000, 2_500, 950],
      [6_400_000, 2_500, 850],
    ]);
    expect(plan.totals.costCents).toBe(1_972);
    expect(plan.signal).toMatchObject({ changedOrders: true, expensiveBoughtStrikesCents: [] });
    expect(plan.warnings.find((w) => w.code === "cost_cap_reached")?.message).toBe(
      "To stay within the cost cap of $20.00, the rungs the paid signal rates cheapest were kept and the rest cut: $65,000 scaled to 4 of 25 contracts; $65,500 dropped.",
    );
    expect(plan.planId).not.toBe(baseline.planId);
    expect(summarizePlan(plan)).toContain(
      `The paid signal (receipt ${RECEIPT.slice(0, 10)}...${RECEIPT.slice(-4)}) rates the strikes bought 2 cheap, 1 fair, 0 expensive, and the cheapest rungs were bought first under the spend cap.`,
    );
  });

  it("judges the limit price including slippage, not the price the signal saw", () => {
    const plan = withSignal({ slippageCents: 3 });
    const at64k = plan.signal?.rungs.find((r) => r.strikeCents === 6_400_000);
    expect(at64k).toMatchObject({ limitPriceCents: 37, edgeBps: 0, rating: "fair" });
  });

  it("leaves a rung unrated when the signal has no such strike or there is no price", () => {
    const signal = paidSignal({
      strikes: [
        { strikeCents: 6_400_000, modelYesBps: 6_300 },
        { strikeCents: 6_500_000, modelYesBps: 5_700 },
      ],
    });
    const plan = withSignal({}, signal);
    expect(plan.signal?.rungs.map((r) => [r.strikeCents, r.rating])).toEqual([
      [6_550_000, "unrated"],
      [6_500_000, "fair"],
      [6_450_000, "unrated"],
      [6_400_000, "cheap"],
    ]);
  });

  it("puts the receipt into the plan id, and is deterministic", () => {
    const a = withSignal();
    expect(withSignal()).toEqual(a);
    const other = withSignal({}, { ...paidSignal(), receiptId: `0x${"ef".repeat(32)}` });
    expect(other.planId).not.toBe(a.planId);
    expect(other.orders).toEqual(a.orders);
  });
});

describe("planHedge with a signal for something else", () => {
  it.each([
    ["event_mismatch", { eventTicker: "BTC2611302200" }, "it is for a different ladder than BTC2611202200"],
    ["asset_mismatch", { asset: "ETH" }, "it is for a different asset"],
    [
      "no_matching_strikes",
      { strikes: [{ strikeCents: 1_000_000, modelYesBps: 9_999 }] },
      "it has none of this ladder's strikes",
    ],
  ] as const)("ignores it (%s) and plans as if it were not there", (reason, overrides, why) => {
    const plan = withSignal({ maxCostCents: 2_000 }, paidSignal(overrides));
    const baseline = planHedge(exampleInput({ maxCostCents: 2_000 }));
    expect(plan.orders).toEqual(baseline.orders);
    expect(plan.signal).toMatchObject({
      used: false,
      ignoredBecause: reason,
      buyOrder: "nearest_spot",
      changedOrders: false,
      rungs: [],
    });
    expect(plan.warnings.map((w) => w.code)).toContain("signal_ignored");
    expect(summarizePlan(plan)).toContain(`was not used: ${why}.`);
  });
});

describe("planHedge signal validation", () => {
  it("refuses a malformed signal", () => {
    const bad = (overrides: Partial<PaidSignal["signal"]>) => () => withSignal({}, paidSignal(overrides));
    expect(bad({ strikes: [{ strikeCents: 6_400_000, modelYesBps: 10_001 }] })).toThrow(PlannerInputError);
    expect(bad({ strikes: [{ strikeCents: 6_400_000, modelYesBps: 50.5 }] })).toThrow(PlannerInputError);
    expect(bad({ model: { fairBandBps: -1 } })).toThrow(PlannerInputError);
    expect(() => withSignal({}, { ...paidSignal(), receiptId: " " })).toThrow(PlannerInputError);
  });
});
