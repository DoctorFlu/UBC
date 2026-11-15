/** Verdicts, rejection reasons and intent statuses, with their onchain encodings and human-readable text. */

// ------------------------------------------------------------------ verdicts

export const VERDICTS = ["approved", "needs_approval", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `previewTrade` (requested extension) returns the verdict as a uint8: 0 approve, 1 needs approval, 2 reject. */
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
  needs_approval: "Waiting for the user's approval",
  rejected: "Rejected",
};

// ------------------------------------------------------------------ rejection reasons

/**
 * The exact strings the contract puts in `IntentRejected`, in the order `_violation` checks them, followed
 * by the two reasons `approveIntent` and `rejectIntent` emit.
 */
export const REASON_CODES = [
  "agent paused",
  "zero amount",
  "daily loss limit reached",
  "over max trade size",
  "category not allowed",
  "over budget",
  "rejected by user",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonInfo {
  /** Short label for a badge or table cell. */
  label: string;
  /** One sentence the agent or the console can show as is. */
  explanation: string;
}

export const REASONS: Readonly<Record<ReasonCode, ReasonInfo>> = {
  "agent paused": {
    label: "Paused",
    explanation: "The user has paused the agent, so no new trades are allowed until trading is resumed.",
  },
  "zero amount": {
    label: "Zero amount",
    explanation: "The trade amount was zero, so there was nothing to approve.",
  },
  "daily loss limit reached": {
    label: "Daily loss limit reached",
    explanation:
      "Realized losses today have reached the user's daily loss limit, so new trades wait until 00:00 UTC.",
  },
  "over max trade size": {
    label: "Over max trade size",
    explanation: "This trade is larger than the maximum size the user allows for a single trade.",
  },
  "category not allowed": {
    label: "Category not allowed",
    explanation:
      "This market's category is not in the list of categories the user allows the agent to trade.",
  },
  "over budget": {
    label: "Over budget",
    explanation: "This buy would take the agent's committed spend past the budget the user set.",
  },
  "rejected by user": {
    label: "Rejected by user",
    explanation: "The trade needed the user's approval and the user declined it.",
  },
};

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}

/** Label and explanation for any reason string, including reasons this version does not know. */
export function describeReason(reason: string): ReasonInfo {
  if (isReasonCode(reason)) return REASONS[reason];
  return {
    label: reason || "Unknown",
    explanation: `The contract rejected this trade with reason "${reason}".`,
  };
}

// ------------------------------------------------------------------ intent status

/** Order and names match the contract's `Status` enum. */
export const INTENT_STATUSES = [
  "none",
  "approved",
  "needs_approval",
  "rejected",
  "executed",
  "failed",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export function intentStatusFromCode(code: number): IntentStatus {
  const status = INTENT_STATUSES[code];
  if (status === undefined) throw new RangeError(`unknown intent status code ${code}`);
  return status;
}

export const INTENT_STATUS_LABELS: Readonly<Record<IntentStatus, string>> = {
  none: "No verdict yet",
  approved: "Approved",
  needs_approval: "Waiting for approval",
  rejected: "Rejected",
  executed: "Executed",
  failed: "Failed",
};
