import { describe, expect, it } from "vitest";
import { Category, categoryMask, evaluateIntent, headroom, type PolicyRules, type PolicyState } from "../src";

const rules: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};
const fresh: PolicyState = { committedCents: 0, lossTodayCents: 0 };
const state = (committedCents: number, lossTodayCents = 0): PolicyState => ({
  committedCents,
  lossTodayCents,
});
const buy = (amountCents: number, category: number = Category.Crypto) => ({
  category,
  isBuy: true,
  amountCents,
});
const sell = (amountCents: number, category: number = Category.Crypto) => ({
  category,
  isBuy: false,
  amountCents,
});

describe("evaluateIntent rules", () => {
  it("approves a small allowed buy", () => {
    expect(evaluateIntent(rules, fresh, buy(1_000))).toEqual({ verdict: "approved" });
  });

  it("rule 6: rejects everything while paused", () => {
    expect(evaluateIntent({ ...rules, paused: true }, fresh, buy(100))).toEqual({
      verdict: "rejected",
      reason: "agent paused",
    });
  });

  it("rejects a zero amount", () => {
    expect(evaluateIntent(rules, fresh, buy(0))).toEqual({ verdict: "rejected", reason: "zero amount" });
    expect(evaluateIntent(rules, fresh, sell(0, Category.Sports))).toMatchObject({ reason: "zero amount" });
  });

  it("rule 3: rejects categories outside the mask", () => {
    expect(evaluateIntent(rules, fresh, buy(100, Category.Sports))).toEqual({
      verdict: "rejected",
      reason: "category not allowed",
    });
    expect(evaluateIntent(rules, fresh, buy(100, 200))).toMatchObject({ reason: "category not allowed" });
  });

  it("rule 2: max trade is inclusive", () => {
    expect(evaluateIntent(rules, fresh, buy(2_500)).verdict).not.toBe("rejected");
    expect(evaluateIntent(rules, fresh, buy(2_501))).toEqual({
      verdict: "rejected",
      reason: "over max trade size",
    });
    expect(evaluateIntent(rules, fresh, sell(2_501))).toMatchObject({ reason: "over max trade size" });
  });

  it("rule 1: budget applies to buys only and is inclusive", () => {
    expect(evaluateIntent(rules, state(19_000), buy(1_000))).toEqual({ verdict: "approved" });
    expect(evaluateIntent(rules, state(19_000), buy(1_001))).toEqual({
      verdict: "rejected",
      reason: "over budget",
    });
    expect(evaluateIntent(rules, state(19_000), sell(1_001))).toEqual({ verdict: "approved" });
    expect(evaluateIntent(rules, state(25_000), buy(1))).toMatchObject({ reason: "over budget" });
  });

  it("rule 5: daily loss limit triggers at the limit, and 0 turns it off", () => {
    expect(evaluateIntent(rules, state(0, 3_999), buy(100)).verdict).toBe("approved");
    expect(evaluateIntent(rules, state(0, 4_000), sell(100))).toEqual({
      verdict: "rejected",
      reason: "daily loss limit reached",
    });
    expect(evaluateIntent({ ...rules, dailyLossCents: 0 }, state(0, 1e9), buy(100)).verdict).toBe("approved");
  });

  it("rule 4: approval above the threshold, exclusive, and 0 means never ask", () => {
    expect(evaluateIntent(rules, fresh, buy(2_000))).toEqual({ verdict: "approved" });
    expect(evaluateIntent(rules, fresh, buy(2_001))).toEqual({ verdict: "needs_approval" });
    expect(evaluateIntent(rules, fresh, sell(2_001))).toEqual({ verdict: "needs_approval" });
    expect(evaluateIntent({ ...rules, approvalAboveCents: 0 }, fresh, buy(2_500))).toEqual({
      verdict: "approved",
    });
  });

  it("applies rules in contract order: paused, zero, daily loss, max trade, category, budget, approval", () => {
    const worst = state(30_000, 9_000);
    const big = buy(3_000, Category.Sports);
    expect(evaluateIntent({ ...rules, paused: true }, worst, buy(0))).toMatchObject({
      reason: "agent paused",
    });
    expect(evaluateIntent(rules, worst, buy(0, Category.Sports))).toMatchObject({ reason: "zero amount" });
    expect(evaluateIntent(rules, worst, big)).toMatchObject({ reason: "daily loss limit reached" });
    const noLoss = state(30_000);
    expect(evaluateIntent(rules, noLoss, big)).toMatchObject({ reason: "over max trade size" });
    expect(evaluateIntent(rules, noLoss, buy(2_100, Category.Sports))).toMatchObject({
      reason: "category not allowed",
    });
    expect(evaluateIntent(rules, noLoss, buy(2_100))).toMatchObject({ reason: "over budget" });
    expect(evaluateIntent(rules, noLoss, sell(2_100))).toEqual({ verdict: "needs_approval" });
  });
});

describe("headroom", () => {
  it("reports remaining budget, next trade size and loss room", () => {
    expect(headroom(rules, state(19_000, 1_500))).toEqual({
      paused: false,
      remainingBudgetCents: 1_000,
      maxNextBuyCents: 1_000,
      maxNextSellCents: 2_500,
      remainingDailyLossCents: 2_500,
      dailyLossLimitReached: false,
      approvalAboveCents: 2_000,
      allowedCategories: [Category.Crypto],
    });
  });

  it("is zero when paused or the loss limit is hit, and null for rules that are off", () => {
    const paused = headroom({ ...rules, paused: true }, fresh);
    expect(paused.maxNextBuyCents).toBe(0);
    expect(paused.maxNextSellCents).toBe(0);

    const lossHit = headroom(rules, state(0, 4_500));
    expect(lossHit).toMatchObject({
      dailyLossLimitReached: true,
      maxNextBuyCents: 0,
      remainingDailyLossCents: 0,
    });

    const off = headroom({ ...rules, dailyLossCents: 0, approvalAboveCents: 0 }, state(30_000));
    expect(off).toMatchObject({
      remainingDailyLossCents: null,
      approvalAboveCents: null,
      remainingBudgetCents: 0,
    });
  });

  it("agrees with evaluateIntent at the boundary it reports", () => {
    const s = state(18_765);
    const room = headroom(rules, s);
    expect(evaluateIntent(rules, s, buy(room.maxNextBuyCents)).verdict).not.toBe("rejected");
    expect(evaluateIntent(rules, s, buy(room.maxNextBuyCents + 1)).verdict).toBe("rejected");
  });
});
