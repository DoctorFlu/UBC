import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  type PolicyRules,
  type ProposedRules,
  categoriesFromMask,
  isCategoryAllowed,
} from "@mandate/shared";

import { formatUsdCents } from "@/lib/format";

export type AmountKey = "budgetCents" | "maxTradeCents" | "approvalAboveCents" | "dailyLossCents";

export const AMOUNT_LABELS: Record<AmountKey, string> = {
  budgetCents: "Budget",
  maxTradeCents: "Max trade size",
  approvalAboveCents: "Approval above",
  dailyLossCents: "Daily loss limit",
};

export interface RuleChange {
  label: string;
  from: string;
  to: string;
}

function amountText(key: AmountKey, cents: number): string {
  if (cents === 0 && key === "approvalAboveCents") return "Never asks";
  if (cents === 0 && key === "dailyLossCents") return "Off";
  return formatUsdCents(cents);
}

/** What signing `next` changes against `current` (null before the first mandate), rule by rule. */
export function rulesDiff(current: PolicyRules | null, next: PolicyRules): RuleChange[] {
  const changes: RuleChange[] = [];
  for (const key of Object.keys(AMOUNT_LABELS) as AmountKey[]) {
    if (current && current[key] === next[key]) continue;
    changes.push({
      label: AMOUNT_LABELS[key],
      from: current ? amountText(key, current[key]) : "Not set",
      to: amountText(key, next[key]),
    });
  }
  for (const id of CATEGORY_IDS) {
    const was = current ? isCategoryAllowed(current.allowedCategories, id) : false;
    const now = isCategoryAllowed(next.allowedCategories, id);
    if (was === now && current) continue;
    if (!current && !now) continue;
    changes.push({
      label: `${CATEGORY_LABELS[id]} markets`,
      from: current ? (was ? "Allowed" : "Blocked") : "Not set",
      to: now ? "Allowed" : "Blocked",
    });
  }
  return changes;
}

/** The values an agent's request asked for, rule by rule, without comparing them to anything. */
export function requestedValues(proposed: ProposedRules): RuleChange[] {
  const values: RuleChange[] = [];
  for (const key of Object.keys(AMOUNT_LABELS) as AmountKey[]) {
    const cents = proposed[key];
    if (cents !== undefined) values.push({ label: AMOUNT_LABELS[key], from: "", to: amountText(key, cents) });
  }
  if (proposed.allowedCategories !== undefined) {
    const allowed = categoriesFromMask(proposed.allowedCategories).map((id) => CATEGORY_LABELS[id]);
    values.push({ label: "Allowed markets", from: "", to: allowed.join(", ") || "None" });
  }
  return values;
}

/** Sentences the owner should read before signing: consequences the form alone does not show. */
export function rulesWarnings(next: PolicyRules, committedCents: number): string[] {
  const warnings: string[] = [];
  if (next.budgetCents < committedCents) {
    warnings.push(
      `The budget is below the ${formatUsdCents(committedCents)} already committed, so every new buy will be rejected as over budget.`,
    );
  }
  if (next.paused) warnings.push("The agent stays paused: signing new rules does not resume it.");
  return warnings;
}
