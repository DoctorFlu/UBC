import { describe, expect, it } from "vitest";
import { Category, categoryMask, evaluateIntent, headroom, type Policy, type PolicyState } from "../src";

const policy: Policy = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};
const fresh: PolicyState = { spentCents: 0, lossTodayCents: 0 };
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
    expect(evaluateIntent(policy, fresh, buy(1_000))).toEqual({ verdict: "approved" });
  });

  it("rule 6: rejects everything while paused", () => {
    expect(evaluateIntent({ ...policy, paused: true }, fresh, buy(100))).toEqual({
      verdict: "rejected",
      reason: "PAUSED",
    });
  });

  it("rule 3: rejects categories outside the mask", () => {
    expect(evaluateIntent(policy, fresh, buy(100, Category.Sports))).toEqual({
      verdict: "rejected",
      reason: "CATEGORY_NOT_ALLOWED",
    });
    expect(evaluateIntent(policy, fresh, buy(100, 200))).toMatchObject({ reason: "CATEGORY_NOT_ALLOWED" });
  });

  it("rule 2: max trade is inclusive", () => {
    expect(evaluateIntent(policy, fresh, buy(2_500)).verdict).not.toBe("rejected");
    expect(evaluateIntent(policy, fresh, buy(2_501))).toEqual({
      verdict: "rejected",
      reason: "OVER_MAX_TRADE",
    });
    expect(evaluateIntent(policy, fresh, sell(2_501))).toEqual({
      verdict: "rejected",
      reason: "OVER_MAX_TRADE",
    });
  });

  it("rule 1: budget applies to buys only and is inclusive", () => {
    const state = { spentCents: 19_000, lossTodayCents: 0 };
    expect(evaluateIntent(policy, state, buy(1_000))).toEqual({ verdict: "approved" });
    expect(evaluateIntent(policy, state, buy(1_001))).toEqual({ verdict: "rejected", reason: "OVER_BUDGET" });
    expect(evaluateIntent(policy, state, sell(1_001))).toEqual({ verdict: "approved" });
  });

  it("rule 1: spend above budget (after the owner lowers it) rejects every buy", () => {
    const state = { spentCents: 25_000, lossTodayCents: 0 };
    expect(evaluateIntent(policy, state, buy(1))).toEqual({ verdict: "rejected", reason: "OVER_BUDGET" });
  });

  it("rule 5: daily loss limit triggers at the limit, and 0 turns it off", () => {
    expect(evaluateIntent(policy, { spentCents: 0, lossTodayCents: 3_999 }, buy(100)).verdict).toBe(
      "approved",
    );
    expect(evaluateIntent(policy, { spentCents: 0, lossTodayCents: 4_000 }, sell(100))).toEqual({
      verdict: "rejected",
      reason: "DAILY_LOSS_LIMIT",
    });
    expect(
      evaluateIntent({ ...policy, dailyLossCents: 0 }, { spentCents: 0, lossTodayCents: 1e9 }, buy(100))
        .verdict,
    ).toBe("approved");
  });

  it("rule 4: approval above the threshold, exclusive, and 0 means never ask", () => {
    expect(evaluateIntent(policy, fresh, buy(2_000))).toEqual({ verdict: "approved" });
    expect(evaluateIntent(policy, fresh, buy(2_001))).toEqual({ verdict: "needs_approval" });
    expect(evaluateIntent(policy, fresh, sell(2_001))).toEqual({ verdict: "needs_approval" });
    expect(evaluateIntent({ ...policy, approvalAboveCents: 0 }, fresh, buy(2_500))).toEqual({
      verdict: "approved",
    });
  });

  it("applies rules in contract order: paused, category, max trade, budget, daily loss, approval", () => {
    const everythingWrong = { spentCents: 30_000, lossTodayCents: 9_000 };
    const big = buy(3_000, Category.Sports);
    expect(evaluateIntent({ ...policy, paused: true }, everythingWrong, big)).toMatchObject({
      reason: "PAUSED",
    });
    expect(evaluateIntent(policy, everythingWrong, big)).toMatchObject({ reason: "CATEGORY_NOT_ALLOWED" });
    expect(evaluateIntent(policy, everythingWrong, buy(3_000))).toMatchObject({ reason: "OVER_MAX_TRADE" });
    expect(evaluateIntent(policy, everythingWrong, buy(2_100))).toMatchObject({ reason: "OVER_BUDGET" });
    expect(evaluateIntent(policy, everythingWrong, sell(2_100))).toMatchObject({
      reason: "DAILY_LOSS_LIMIT",
    });
  });
});

describe("headroom", () => {
  it("reports remaining budget, next trade size and loss room", () => {
    expect(headroom(policy, { spentCents: 19_000, lossTodayCents: 1_500 })).toEqual({
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
    const paused = headroom({ ...policy, paused: true }, fresh);
    expect(paused.maxNextBuyCents).toBe(0);
    expect(paused.maxNextSellCents).toBe(0);

    const lossHit = headroom(policy, { spentCents: 0, lossTodayCents: 4_500 });
    expect(lossHit).toMatchObject({
      dailyLossLimitReached: true,
      maxNextBuyCents: 0,
      remainingDailyLossCents: 0,
    });

    const off = headroom(
      { ...policy, dailyLossCents: 0, approvalAboveCents: 0 },
      { spentCents: 30_000, lossTodayCents: 0 },
    );
    expect(off).toMatchObject({
      remainingDailyLossCents: null,
      approvalAboveCents: null,
      remainingBudgetCents: 0,
    });
  });

  it("agrees with evaluateIntent at the boundary it reports", () => {
    const state = { spentCents: 18_765, lossTodayCents: 0 };
    const room = headroom(policy, state);
    expect(evaluateIntent(policy, state, buy(room.maxNextBuyCents)).verdict).not.toBe("rejected");
    expect(evaluateIntent(policy, state, buy(room.maxNextBuyCents + 1)).verdict).toBe("rejected");
  });
});
