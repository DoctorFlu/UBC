import {
  Category,
  type CategoryId,
  type PolicyRules,
  categoriesFromMask,
  categoryMask,
} from "@mandate/shared";

import { formatUsdCents, parseUsdToCents } from "@/lib/format";

import { AMOUNT_LABELS, type AmountKey } from "./rules-diff";

/** What each dollar rule does, under its field: on the Rules page and in New mandate (#95) alike. */
export const amountHints: Record<AmountKey, string> = {
  budgetCents: "All the agent may ever commit to buys. It is a lifetime cap and does not reset.",
  maxTradeCents: "Larger intents are rejected as “over max trade size”.",
  approvalAboveCents: "Intents above this wait for your signature. 0 means never ask.",
  dailyLossCents: "New intents stop once today’s realized losses reach it. 0 turns it off.",
};

export const AMOUNT_KEYS = Object.keys(AMOUNT_LABELS) as AmountKey[];

/** A starting point for the first rules: small, crypto only, and every rule on. */
export const FIRST_MANDATE: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

function plainDollars(cents: number) {
  return formatUsdCents(cents, { trimWholeCents: true }).replace("$", "");
}

export interface Draft {
  amounts: Record<AmountKey, string>;
  categories: readonly CategoryId[];
}

export function draftFrom(rules: PolicyRules): Draft {
  return {
    amounts: Object.fromEntries(AMOUNT_KEYS.map((key) => [key, plainDollars(rules[key])])) as Record<
      AmountKey,
      string
    >,
    categories: categoriesFromMask(rules.allowedCategories),
  };
}

export interface CheckedDraft {
  errors: Partial<Record<AmountKey, string>>;
  /** The rules the draft means, or null while any field is wrong or no category is allowed. */
  next: PolicyRules | null;
}

/** Reads a draft into rules, with one plain sentence per wrong field. `paused` is kept from `paused`. */
export function checkDraft(draft: Draft, paused: boolean): CheckedDraft {
  const parsed = Object.fromEntries(
    AMOUNT_KEYS.map((key) => [key, parseUsdToCents(draft.amounts[key])]),
  ) as Record<AmountKey, number | null>;
  const errors: Partial<Record<AmountKey, string>> = {};
  for (const key of AMOUNT_KEYS) {
    if (parsed[key] === null) errors[key] = "Enter a dollar amount, like 50 or 50.25.";
  }
  if (
    parsed.maxTradeCents !== null &&
    parsed.budgetCents !== null &&
    parsed.maxTradeCents > parsed.budgetCents
  ) {
    errors.maxTradeCents = "The max trade size can't be more than the budget.";
  }
  if (
    parsed.approvalAboveCents !== null &&
    parsed.maxTradeCents !== null &&
    parsed.approvalAboveCents > parsed.maxTradeCents
  ) {
    errors.approvalAboveCents = "Set it at or below the max trade size, or 0 to never ask.";
  }
  const hasErrors = Object.values(errors).some(Boolean) || draft.categories.length === 0;
  return {
    errors,
    next: hasErrors
      ? null
      : {
          budgetCents: parsed.budgetCents ?? 0,
          maxTradeCents: parsed.maxTradeCents ?? 0,
          approvalAboveCents: parsed.approvalAboveCents ?? 0,
          dailyLossCents: parsed.dailyLossCents ?? 0,
          allowedCategories: categoryMask(draft.categories),
          paused,
        },
  };
}
