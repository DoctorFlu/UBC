import { describe, expect, it } from "vitest";

import { FIXTURE_RECEIPT, fixtureSnapshot } from "@/fixtures";

import { budgetHasReset, budgetReading, intentsByReceipt, paymentHref } from "./links";

describe("intentsByReceipt", () => {
  it("links a payment only to intents whose verified sealed reason cites its receipt", () => {
    const chain = fixtureSnapshot.chain;
    const linked = intentsByReceipt(chain).get(FIXTURE_RECEIPT) ?? [];
    // Intent 0's reason is verified; intent 1 cites the same document but its hash was tampered with.
    expect(linked.map((intent) => intent.id)).toEqual([0]);
    expect(intentsByReceipt(null).size).toBe(0);
    expect(paymentHref(FIXTURE_RECEIPT.toUpperCase())).toBe(`/payments#payment-${FIXTURE_RECEIPT}`);
  });
});

describe("budgetReading", () => {
  const budget = fixtureSnapshot.offchain.signalBudget;
  if (!budget) throw new Error("the fixture has no budget");

  it("reads the snapshot's spend until it resets", () => {
    expect(budgetReading(budget, budgetHasReset(budget, Date.parse("2026-11-15T23:59:59Z")))).toEqual({
      spent: 1000n,
      daily: 20000n,
      maxPerPurchase: 5000n,
      reset: false,
    });
  });

  it("reads 0 spent from resetsAt on, until a new snapshot arrives", () => {
    expect(budgetReading(budget, budgetHasReset(budget, Date.parse(budget.resetsAt)))).toMatchObject({
      spent: 0n,
      reset: true,
    });
  });
});
