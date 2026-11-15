import { categoriesFromMask, isCategoryAllowed, type CategoryId } from "./categories";
import type { ReasonCode } from "./reasons";
import type { Policy } from "./types";

/**
 * Offchain mirror of the contract's rule function. It must give the same verdict and reason as
 * `previewTrade` and `proposeTrade` for the same policy and state; the devchain fuzz test checks this.
 */

/** The parts of contract state the rules read, besides the policy. */
export interface PolicyState {
  /** Cents committed by approved buys, corrected to the filled amount once results land. */
  spentCents: number;
  /** Realized loss recorded in the current UTC day. */
  lossTodayCents: number;
}

/** The parts of an intent the rules read. */
export interface RuleInput {
  category: number;
  isBuy: boolean;
  amountCents: number;
}

export type Evaluation =
  { verdict: "approved" } | { verdict: "needs_approval" } | { verdict: "rejected"; reason: ReasonCode };

/** Whether a buy of `amountCents` fits the remaining budget. Mirrors the contract's `_fitsBudget`. */
export function fitsBudget(policy: Policy, state: PolicyState, amountCents: number): boolean {
  return state.spentCents <= policy.budgetCents && amountCents <= policy.budgetCents - state.spentCents;
}

export function isDailyLossLimitReached(policy: Policy, state: PolicyState): boolean {
  return policy.dailyLossCents !== 0 && state.lossTodayCents >= policy.dailyLossCents;
}

/**
 * Runs the rules in contract order: paused, category, max trade, budget (buys only), daily loss, then
 * the approval threshold. The first failing rule decides the reason.
 */
export function evaluateIntent(policy: Policy, state: PolicyState, intent: RuleInput): Evaluation {
  if (policy.paused) return { verdict: "rejected", reason: "PAUSED" };
  if (!isCategoryAllowed(policy.allowedCategories, intent.category)) {
    return { verdict: "rejected", reason: "CATEGORY_NOT_ALLOWED" };
  }
  if (intent.amountCents > policy.maxTradeCents) return { verdict: "rejected", reason: "OVER_MAX_TRADE" };
  if (intent.isBuy && !fitsBudget(policy, state, intent.amountCents)) {
    return { verdict: "rejected", reason: "OVER_BUDGET" };
  }
  if (isDailyLossLimitReached(policy, state)) return { verdict: "rejected", reason: "DAILY_LOSS_LIMIT" };
  if (policy.approvalAboveCents !== 0 && intent.amountCents > policy.approvalAboveCents) {
    return { verdict: "needs_approval" };
  }
  return { verdict: "approved" };
}

export interface Headroom {
  paused: boolean;
  /** Budget left for buys. 0 when spend is at or over budget. */
  remainingBudgetCents: number;
  /** Largest buy that would not be rejected right now (it may still need approval). 0 when nothing fits. */
  maxNextBuyCents: number;
  /** Largest sell that would not be rejected right now. Sells do not use budget. */
  maxNextSellCents: number;
  /** Loss left before the daily limit stops trading, or null when the rule is off. */
  remainingDailyLossCents: number | null;
  dailyLossLimitReached: boolean;
  /** Intents above this wait for the owner, or null when approval is never asked. */
  approvalAboveCents: number | null;
  allowedCategories: CategoryId[];
}

export function headroom(policy: Policy, state: PolicyState): Headroom {
  const remainingBudgetCents = Math.max(0, policy.budgetCents - state.spentCents);
  const dailyLossLimitReached = isDailyLossLimitReached(policy, state);
  const blocked = policy.paused || dailyLossLimitReached;
  return {
    paused: policy.paused,
    remainingBudgetCents,
    maxNextBuyCents: blocked ? 0 : Math.min(policy.maxTradeCents, remainingBudgetCents),
    maxNextSellCents: blocked ? 0 : policy.maxTradeCents,
    remainingDailyLossCents:
      policy.dailyLossCents === 0 ? null : Math.max(0, policy.dailyLossCents - state.lossTodayCents),
    dailyLossLimitReached,
    approvalAboveCents: policy.approvalAboveCents === 0 ? null : policy.approvalAboveCents,
    allowedCategories: categoriesFromMask(policy.allowedCategories),
  };
}
