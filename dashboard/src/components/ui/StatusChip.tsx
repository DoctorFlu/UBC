import { INTENT_STATUS_LABELS, type IntentStatus, describeReason } from "@mandate/shared";

import { cx } from "@/lib/cx";

import styles from "./StatusChip.module.css";

/** Every state a status chip can show: the contract's intent statuses, plus "paused" for the mandate. */
export type StatusKind = IntentStatus | "paused";

/** Short words for the chip. The contract's own labels, except the one too long for a chip. */
export const statusLabels: Record<StatusKind, string> = {
  ...INTENT_STATUS_LABELS,
  needs_approval: "Waiting",
  paused: "Paused",
};

/** What each status means, for tooltips and screen readers. */
export const statusDescriptions: Record<StatusKind, string> = {
  none: "The Policy contract has not decided this intent yet.",
  approved: "The Policy contract approved this intent; the executor has not reported a result yet.",
  needs_approval: "Above the approval threshold: waiting for the owner to approve or reject it.",
  rejected: "The Policy contract rejected this intent.",
  executed: "Approved, and the executor recorded a fill.",
  failed: "Approved, but the executor recorded that the order did not fill.",
  paused: "The mandate is paused; new intents are rejected.",
};

export interface StatusChipProps {
  status: StatusKind;
  /** The contract's reason string for a rejection, shown after the label exactly as emitted. */
  reason?: string | null | undefined;
  className?: string;
}

/** The one way a verdict is shown anywhere in the console: a lamp, a word, and the contract's reason. */
export function StatusChip({ status, reason, className }: StatusChipProps) {
  const title = reason
    ? `${statusDescriptions[status]} ${describeReason(reason).explanation}`
    : statusDescriptions[status];
  return (
    <span className={cx(styles.chip, styles[status], className)} title={title} data-status={status}>
      <span className={styles.lamp} aria-hidden />
      <span>{statusLabels[status]}</span>
      {reason ? (
        <span className={styles.code}>
          <span className="visually-hidden">, reason </span>
          {reason}
        </span>
      ) : null}
    </span>
  );
}
