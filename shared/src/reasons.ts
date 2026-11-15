/** Verdicts, reason codes and intent statuses, with their onchain encodings and human-readable text. */

// ------------------------------------------------------------------ verdicts

export const VERDICTS = ["approved", "needs_approval", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `previewTrade` returns the verdict as a uint8: 0 approve, 1 needs approval, 2 reject. */
export function verdictFromCode(code: number): Verdict {
  const verdict = VERDICTS[code];
  if (verdict === undefined) throw new RangeError(`unknown verdict code ${code}`);
  return verdict;
}

export function verdictToCode(verdict: Verdict): number {
  return VERDICTS.indexOf(verdict);
}

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  approved: "Approved",
  needs_approval: "Waiting for owner approval",
  rejected: "Rejected",
};

// ------------------------------------------------------------------ reason codes

export const REASON_CODES = [
  "PAUSED",
  "CATEGORY_NOT_ALLOWED",
  "OVER_MAX_TRADE",
  "OVER_BUDGET",
  "DAILY_LOSS_LIMIT",
  "REJECTED_BY_OWNER",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonInfo {
  /** Short label for a badge or table cell. */
  label: string;
  /** One sentence the agent or the console can show as is. */
  explanation: string;
}

export const REASONS: Readonly<Record<ReasonCode, ReasonInfo>> = {
  PAUSED: {
    label: "Paused",
    explanation: "The owner has paused the agent, so no new trades are allowed until trading is resumed.",
  },
  CATEGORY_NOT_ALLOWED: {
    label: "Category not allowed",
    explanation:
      "This market's category is not in the list of categories the owner allows the agent to trade.",
  },
  OVER_MAX_TRADE: {
    label: "Over max trade size",
    explanation: "This trade is larger than the maximum size the owner allows for a single trade.",
  },
  OVER_BUDGET: {
    label: "Over budget",
    explanation: "This buy would take the agent's total committed spend past the budget the owner set.",
  },
  DAILY_LOSS_LIMIT: {
    label: "Daily loss limit reached",
    explanation:
      "Realized losses today have reached the owner's daily loss limit, so new trades wait until tomorrow (UTC).",
  },
  REJECTED_BY_OWNER: {
    label: "Rejected by owner",
    explanation: "The trade needed the owner's approval and the owner declined it.",
  },
};

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}

/** Label and explanation for any reason string, including codes this version does not know. */
export function describeReason(reason: string): ReasonInfo {
  if (isReasonCode(reason)) return REASONS[reason];
  return {
    label: reason || "Unknown",
    explanation: `The contract rejected this trade with reason "${reason}".`,
  };
}

// ------------------------------------------------------------------ intent status

/** Order matches the contract's `Status` enum. `none` means no verdict is known for the intent. */
export const INTENT_STATUSES = [
  "none",
  "needs_approval",
  "approved",
  "rejected",
  "filled",
  "unfilled",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export function intentStatusFromCode(code: number): IntentStatus {
  const status = INTENT_STATUSES[code];
  if (status === undefined) throw new RangeError(`unknown intent status code ${code}`);
  return status;
}

export const INTENT_STATUS_LABELS: Readonly<Record<IntentStatus, string>> = {
  none: "No verdict",
  needs_approval: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  filled: "Filled",
  unfilled: "Not filled",
};
