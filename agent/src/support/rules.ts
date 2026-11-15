/**
 * The mandate's rules in the words the agent passes on to its owner: which rule a verdict comes
 * from, its stable code, and the numbers behind it.
 */
import * as z from "zod";
import {
  categoriesFromMask,
  categoryLabel,
  describeReason,
  formatCents,
  type PolicyRules,
  type PolicyState,
} from "@mandate/shared";
import { reason, type Reason } from "../mcp/envelope";

/** Policy fields a verdict can come from. `owner` is a decision the owner made by hand. */
export const RULE_NAMES = [
  "paused",
  "amount",
  "dailyLossCents",
  "maxTradeCents",
  "allowedCategories",
  "budgetCents",
  "approvalAboveCents",
  "owner",
] as const;
export type RuleName = (typeof RULE_NAMES)[number];

const RULE_OF_REASON: Readonly<Record<string, RuleName>> = {
  "agent paused": "paused",
  "zero amount": "amount",
  "daily loss limit reached": "dailyLossCents",
  "over max trade size": "maxTradeCents",
  "category not allowed": "allowedCategories",
  "over budget": "budgetCents",
  "rejected by user": "owner",
};

export const RuleHitSchema = z.object({
  rule: z.enum(RULE_NAMES).nullable().describe("The policy field behind the verdict, or null if unknown"),
  code: z.string().describe("Stable UPPER_SNAKE_CASE code"),
  contractReason: z
    .string()
    .nullable()
    .describe("The contract's own reason string, for example 'over budget'"),
  explanation: z.string().describe("One sentence to tell the owner"),
  detail: z.string().nullable().describe("The numbers behind it, when known"),
});
export type RuleHit = z.infer<typeof RuleHitSchema>;

/** The trade the rules are applied to. */
export interface TradeFacts {
  category: number;
  isBuy: boolean;
  amountCents: number;
}

/** `"over budget"` to `OVER_BUDGET`; the owner's rejection reads `REJECTED_BY_OWNER`. */
export function reasonCode(contractReason: string): string {
  if (contractReason === "rejected by user") return "REJECTED_BY_OWNER";
  const code = contractReason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(code) ? code : `CONTRACT_${code || "REJECTED"}`;
}

/** Which rule rejected a trade, in plain words, with the numbers when the rules are known. */
export function rejectionHit(
  contractReason: string,
  context?: { rules: PolicyRules; state: PolicyState; trade: TradeFacts },
): RuleHit {
  return {
    rule: RULE_OF_REASON[contractReason] ?? null,
    code: reasonCode(contractReason),
    contractReason,
    explanation: describeReason(contractReason).explanation.replaceAll("the user", "the owner"),
    detail: context === undefined ? null : rejectionDetail(contractReason, context),
  };
}

/** Why a trade waits for the owner. */
export function approvalHit(rules: PolicyRules | undefined, amountCents: number): RuleHit {
  return {
    rule: "approvalAboveCents",
    code: "OWNER_APPROVAL_REQUIRED",
    contractReason: null,
    explanation: "This trade is above the size the owner approves by hand, so it waits for the owner.",
    detail:
      rules === undefined
        ? null
        : `Trades above ${formatCents(rules.approvalAboveCents)} need the owner's approval; this one is ${formatCents(amountCents)}.`,
  };
}

export function hitReason(hit: RuleHit): Reason {
  return reason(hit.code, hit.detail === null ? hit.explanation : `${hit.explanation} ${hit.detail}`);
}

function rejectionDetail(
  contractReason: string,
  { rules, state, trade }: { rules: PolicyRules; state: PolicyState; trade: TradeFacts },
): string | null {
  switch (contractReason) {
    case "agent paused":
      return "The owner's pause switch is on.";
    case "zero amount":
      return "The amount was $0.00.";
    case "daily loss limit reached":
      return `Daily loss limit ${formatCents(rules.dailyLossCents)}; realized loss today ${formatCents(state.lossTodayCents)}.`;
    case "over max trade size":
      return `Max trade ${formatCents(rules.maxTradeCents)}; this trade ${formatCents(trade.amountCents)}.`;
    case "category not allowed": {
      const allowed = categoriesFromMask(rules.allowedCategories).map(categoryLabel);
      return `This market is in ${categoryLabel(trade.category)}; allowed: ${allowed.length === 0 ? "none" : allowed.join(", ")}.`;
    }
    case "over budget": {
      const left = Math.max(0, rules.budgetCents - state.committedCents);
      return `Budget ${formatCents(rules.budgetCents)}, ${formatCents(state.committedCents)} committed, ${formatCents(left)} left; this buy ${formatCents(trade.amountCents)}.`;
    }
    default:
      return null;
  }
}

/** Next step after a rejection: explain, never work around. */
export const AFTER_REJECTION = {
  actor: "owner" as const,
  hint: "Only the owner can change this rule. Explain the rule and the numbers to them; do not retry, resize or split the trade. If they want a different rule, call request_policy_change with their reason.",
};
