import { categoriesFromMask, isCategoryAllowed, type CategoryId } from "./categories";
import type { ReasonCode } from "./reasons";
import type { PolicyRules } from "./types";

/**
 * Offchain mirror of the contract's rules (`_violation` plus the approval threshold in `proposeTrade`).
 * It must give the same verdict and reason as the contract for the same rules and state; the devchain fuzz
 * test checks this against both the production and the reference contract.
 */

/** The parts of contract state the rules read, besides the rules themselves. */
export interface PolicyState {
  /** `committedCents()`: budget used by approved buys, corrected to the filled amount once results land. */
  committedCents: number;
  /** `lossTodayCents()`: realized loss recorded in the current UTC day. */
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

/** Whether a buy of `amountCents` fits the budget: `committedCents + amountCents <= budgetCents`. */
export function fitsBudget(rules: PolicyRules, state: PolicyState, amountCents: number): boolean {
  return state.committedCents + amountCents <= rules.budgetCents;
}

export function isDailyLossLimitReached(rules: PolicyRules, state: PolicyState): boolean {
  return rules.dailyLossCents !== 0 && state.lossTodayCents >= rules.dailyLossCents;
}

/**
 * Runs the rules in contract order and stops at the first failure: paused, zero amount, daily loss,
 * max trade, category, budget (buys only), then the approval threshold.
 */
export function evaluateIntent(rules: PolicyRules, state: PolicyState, intent: RuleInput): Evaluation {
  const reason = violation(rules, state, intent);
  if (reason !== null) return { verdict: "rejected", reason };
  if (rules.approvalAboveCents !== 0 && intent.amountCents > rules.approvalAboveCents) {
    return { verdict: "needs_approval" };
  }
  return { verdict: "approved" };
}

function violation(rules: PolicyRules, state: PolicyState, intent: RuleInput): ReasonCode | null {
  if (rules.paused) return "agent paused";
  if (intent.amountCents === 0) return "zero amount";
  if (isDailyLossLimitReached(rules, state)) return "daily loss limit reached";
  if (intent.amountCents > rules.maxTradeCents) return "over max trade size";
  if (!isCategoryAllowed(rules.allowedCategories, intent.category)) return "category not allowed";
  if (intent.isBuy && !fitsBudget(rules, state, intent.amountCents)) return "over budget";
  return null;
}

export interface Headroom {
  paused: boolean;
  /** `remainingBudgetCents()`: budget left for buys, 0 when committed spend is at or over budget. */
  remainingBudgetCents: number;
  /** Largest buy that would not be rejected right now (it may still need approval). 0 when nothing fits. */
  maxNextBuyCents: number;
  /** Largest sell that would not be rejected right now. Sells do not use budget. */
  maxNextSellCents: number;
  /** Loss left before the daily limit stops trading, or null when the rule is off. */
  remainingDailyLossCents: number | null;
  dailyLossLimitReached: boolean;
  /** Intents above this wait for the user, or null when approval is never asked. */
  approvalAboveCents: number | null;
  allowedCategories: CategoryId[];
}

export function headroom(rules: PolicyRules, state: PolicyState): Headroom {
  const remainingBudgetCents = Math.max(0, rules.budgetCents - state.committedCents);
  const dailyLossLimitReached = isDailyLossLimitReached(rules, state);
  const blocked = rules.paused || dailyLossLimitReached;
  return {
    paused: rules.paused,
    remainingBudgetCents,
    maxNextBuyCents: blocked ? 0 : Math.min(rules.maxTradeCents, remainingBudgetCents),
    maxNextSellCents: blocked ? 0 : rules.maxTradeCents,
    remainingDailyLossCents:
      rules.dailyLossCents === 0 ? null : Math.max(0, rules.dailyLossCents - state.lossTodayCents),
    dailyLossLimitReached,
    approvalAboveCents: rules.approvalAboveCents === 0 ? null : rules.approvalAboveCents,
    allowedCategories: categoriesFromMask(rules.allowedCategories),
  };
}
