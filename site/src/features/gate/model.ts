import {
  Category,
  REASON_CODES,
  categoriesFromMask,
  categoryLabel,
  categoryMask,
  evaluateIntent,
  formatCents,
  type CategoryId,
  type Evaluation,
  type PolicyRules,
  type PolicyState,
  type ReasonCode,
} from "@mandate/shared/rules";

/**
 * The gate on the landing page: a sample mandate, a trade the visitor sets, and the verdict from
 * `evaluateIntent`, the rule check the agent's server and the console run, which the devchain fuzz
 * test holds to the contract. Nothing here decides a verdict; it only lays the answer out.
 */

/** The demo chain's rules (devchain DEMO_POLICY); a unit test keeps the two equal. */
export const SAMPLE_RULES: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

/** A fresh mandate: nothing committed, no loss today. */
export const SAMPLE_STATE: PolicyState = { committedCents: 0, lossTodayCents: 0 };

/** The markets the visitor can pick: the one the sample allows and two it does not. */
export const GATE_CATEGORIES = [Category.Crypto, Category.Sports, Category.Politics] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];

/** Trade size bounds in cents. The slider covers all three verdicts; typing can go further. */
export const AMOUNT_MIN_CENTS = 100;
export const AMOUNT_SLIDER_MAX_CENTS = 4_000;
export const AMOUNT_MAX_CENTS = 100_000;
export const DEFAULT_AMOUNT_CENTS = 1_800;

export interface GateInput {
  amountCents: number;
  category: GateCategory;
  paused: boolean;
}

export const DEFAULT_INPUT: GateInput = {
  amountCents: DEFAULT_AMOUNT_CENTS,
  category: Category.Crypto,
  paused: false,
};

export function clampAmount(cents: number): number {
  if (!Number.isFinite(cents)) return AMOUNT_MIN_CENTS;
  return Math.min(AMOUNT_MAX_CENTS, Math.max(AMOUNT_MIN_CENTS, Math.round(cents)));
}

/** The rules with the visitor's pause switch applied; the pause switch is a rule like the others. */
export function rulesFor(input: GateInput): PolicyRules {
  return { ...SAMPLE_RULES, paused: input.paused };
}

export function evaluateGate(input: GateInput): Evaluation {
  return evaluateIntent(rulesFor(input), SAMPLE_STATE, {
    category: input.category,
    isBuy: true,
    amountCents: clampAmount(input.amountCents),
  });
}

// ------------------------------------------------------------------ the circuit

/** A row of the schedule: one rule, in the order the contract checks them. */
export type RowId = "paused" | "dailyLoss" | "maxTrade" | "markets" | "budget" | "approval";

/** closed: checked and passed. tripped: the rule that rejected. held: waits for the owner. idle: not reached. */
export type RowState = "closed" | "tripped" | "held" | "idle";

export interface Row {
  id: RowId;
  label: string;
  rating: string;
  /** The contract's reason when this rule rejects, or null for the approval line. */
  reason: ReasonCode | null;
}

function allowedText(rules: PolicyRules): string {
  const allowed = categoriesFromMask(rules.allowedCategories).map(categoryLabel);
  return allowed.length === 1 ? `${allowed[0] ?? ""} only` : allowed.join(", ");
}

const RULE_ROWS: readonly Row[] = [
  { id: "paused", label: "Pause switch", rating: "", reason: "agent paused" },
  {
    id: "dailyLoss",
    label: "Daily loss limit",
    rating: formatCents(SAMPLE_RULES.dailyLossCents),
    reason: "daily loss limit reached",
  },
  {
    id: "maxTrade",
    label: "Max trade",
    rating: formatCents(SAMPLE_RULES.maxTradeCents),
    reason: "over max trade size",
  },
  { id: "markets", label: "Markets", rating: allowedText(SAMPLE_RULES), reason: "category not allowed" },
  { id: "budget", label: "Budget", rating: formatCents(SAMPLE_RULES.budgetCents), reason: "over budget" },
];

const APPROVAL_ROW: Row = {
  id: "approval",
  label: "Your signature above",
  rating: formatCents(SAMPLE_RULES.approvalAboveCents),
  reason: null,
};

/** The schedule as the contract walks it: rejection rules in `REASON_CODES` order, then the approval line. */
export function scheduleRows(input: GateInput): Row[] {
  const order = (row: Row) => (row.reason === null ? Infinity : REASON_CODES.indexOf(row.reason));
  const rules = [...RULE_ROWS]
    .sort((a, b) => order(a) - order(b))
    .map((row) =>
      row.id === "paused" ? { ...row, rating: input.paused ? "On, agent paused" : "Off, agent live" } : row,
    );
  return [...rules, APPROVAL_ROW];
}

/**
 * Where the check stopped. The contract stops at the first failing rule, so rules before it passed and
 * rules after it were never reached; the approval line only matters once every rule passed.
 */
export function rowState(row: Row, evaluation: Evaluation): RowState {
  if (evaluation.verdict === "rejected") {
    if (row.reason === null) return "idle";
    const stoppedAt = REASON_CODES.indexOf(evaluation.reason);
    const at = REASON_CODES.indexOf(row.reason);
    if (at < stoppedAt) return "closed";
    return at === stoppedAt ? "tripped" : "idle";
  }
  if (row.reason !== null) return "closed";
  return evaluation.verdict === "needs_approval" ? "held" : "closed";
}

// ------------------------------------------------------------------ the verdict, in words

export type Tone = "approved" | "held" | "rejected";

export interface VerdictCopy {
  tone: Tone;
  title: string;
  detail: string;
  /** The contract's reason string, shown as the code it is, or null. */
  code: ReasonCode | null;
}

function marketName(category: CategoryId): string {
  return `${categoryLabel(category)} markets`;
}

function rejectionDetail(reason: ReasonCode, input: GateInput): string {
  const rules = rulesFor(input);
  const amount = formatCents(clampAmount(input.amountCents));
  switch (reason) {
    case "agent paused":
      return "You paused the agent. The contract refuses every new order until you resume it.";
    case "zero amount":
      return "A $0.00 order has nothing to approve.";
    case "daily loss limit reached":
      return `Today's realized losses reached the ${formatCents(rules.dailyLossCents)} limit. New orders wait until 00:00 UTC.`;
    case "over max trade size":
      return `${amount} is over the ${formatCents(rules.maxTradeCents)} largest single order this mandate allows.`;
    case "category not allowed":
      return `${marketName(input.category)} are not in this mandate. It allows ${allowedText(rules)}.`;
    case "over budget":
      return `This buy would take committed spend past the ${formatCents(rules.budgetCents)} budget.`;
    case "rejected by user":
      return "You declined it.";
  }
}

export function verdictCopy(evaluation: Evaluation, input: GateInput): VerdictCopy {
  const amount = formatCents(clampAmount(input.amountCents));
  switch (evaluation.verdict) {
    case "approved":
      return {
        tone: "approved",
        title: "Approved",
        detail: `${amount} passes every rule. The executor may place it.`,
        code: null,
      };
    case "needs_approval":
      return {
        tone: "held",
        title: "Held for your signature",
        detail: `${amount} is above your ${formatCents(SAMPLE_RULES.approvalAboveCents)} line, so it waits until you approve or reject it with your wallet.`,
        code: null,
      };
    case "rejected":
      return {
        tone: "rejected",
        title: "Rejected",
        detail: rejectionDetail(evaluation.reason, input),
        code: evaluation.reason,
      };
  }
}
