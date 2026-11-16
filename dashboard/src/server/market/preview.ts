import "server-only";

import type { Ladder } from "@mandate/gemini";
import { planHedge } from "@mandate/planner";
import { Category, type ConsoleHolding, type PolicyRules, isCategoryAllowed } from "@mandate/shared";

import { PREVIEW_DROP_PERCENT, type PreviewState } from "@/lib/hedge/types";
import { formatUsdCents } from "@/lib/format";

/**
 * A preview of what a hedge could look like, for an asset the agent has not planned yet: the same
 * planner the agent runs, on the owner's holding, the mandate's limits and the live ladder, with a
 * protection goal the console assumes (spot down to `PREVIEW_DROP_PERCENT` below it) and the remaining
 * budget as the spend cap. It is never stored and never shown as the agent's plan.
 */
export function previewPlan(input: {
  asset: string;
  holdings: readonly ConsoleHolding[];
  rules: PolicyRules | null;
  committedCents: number;
  ladder: Ladder;
}): PreviewState {
  const holding = input.holdings.find((candidate) => candidate.asset === input.asset);
  if (!holding) {
    return { status: "unavailable", reason: `Save your ${input.asset} holding to see a preview.` };
  }
  if (!input.rules) {
    return { status: "unavailable", reason: "Sign a mandate first: a hedge has to fit its limits." };
  }
  const remainingBudgetCents = Math.max(0, input.rules.budgetCents - input.committedCents);
  if (remainingBudgetCents === 0) {
    return {
      status: "unavailable",
      reason: `The mandate's budget is fully committed (${formatUsdCents(input.rules.budgetCents)}), so no hedge fits.`,
    };
  }
  try {
    const plan = planHedge({
      holding: { asset: input.asset, quantity: holding.quantity },
      ladder: input.ladder,
      goal: { dropPercent: PREVIEW_DROP_PERCENT },
      maxCostCents: remainingBudgetCents,
      limits: {
        maxTradeCents: input.rules.maxTradeCents,
        remainingBudgetCents,
        categoryAllowed: isCategoryAllowed(input.rules.allowedCategories, Category.Crypto),
      },
    });
    return {
      status: "ready",
      plan,
      assumptions: {
        holdingQuantity: holding.quantity,
        dropPercent: PREVIEW_DROP_PERCENT,
        maxCostCents: remainingBudgetCents,
        maxTradeCents: input.rules.maxTradeCents,
        remainingBudgetCents,
      },
    };
  } catch {
    return { status: "unavailable", reason: "The planner could not plan this holding on this ladder." };
  }
}
