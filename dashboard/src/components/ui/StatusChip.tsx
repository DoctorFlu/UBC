import { INTENT_STATUS_LABELS, type IntentStatus, NOT_FILLED, describeReason } from "@mandate/shared";

import { Advanced } from "@/lib/advanced/Advanced";
import { cx } from "@/lib/cx";

import styles from "./StatusChip.module.css";

/** Every state a status chip can show: the contract's intent statuses, plus "paused" for the mandate. */
export type StatusKind = IntentStatus | "paused";

/**
 * Short words for the chip: the contract's own labels, except the one too long for a chip, and "Failed",
 * which reads as if something broke when the order only did not fill. Advanced view and Audit keep the
 * contract's word (`INTENT_STATUS_LABELS`).
 */
export const statusLabels: Record<StatusKind, string> = {
  ...INTENT_STATUS_LABELS,
  needs_approval: "Waiting",
  failed: NOT_FILLED,
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
  paused: "Trading is paused; new intents are rejected.",
};

export interface StatusChipProps {
  status: StatusKind;
  /** The contract's reason string for a rejection, shown after the label exactly as emitted. */
  reason?: string | null | undefined;
  /** Words for the chip in place of the status's own, where the context changes what it means. */
  label?: string | undefined;
  /** What the chip means, in place of the status's own description, when `label` changes it. */
  description?: string | undefined;
  /** What the executor's journal adds to the status (`partly_filled`, `recording`), for styling and tests. */
  fill?: string | undefined;
  className?: string;
}

/** The one way a verdict is shown anywhere in the console: a lamp, a word, and the contract's reason. */
export function StatusChip({ status, reason, label, description, fill, className }: StatusChipProps) {
  const meaning = description ?? statusDescriptions[status];
  const title = reason ? `${meaning} ${describeReason(reason).explanation}` : meaning;
  return (
    <span
      className={cx(styles.chip, styles[status], className)}
      title={title}
      data-status={status}
      data-fill={fill}
    >
      <span className={styles.lamp} aria-hidden />
      <span>
        {status === "failed" && (label === undefined || label === NOT_FILLED) ? (
          // The contract's own word in Advanced view, where the console shows what the contract emitted.
          <Advanced fallback={NOT_FILLED}>{INTENT_STATUS_LABELS.failed}</Advanced>
        ) : (
          (label ?? statusLabels[status])
        )}
      </span>
      {reason ? (
        <span className={styles.code} data-reason>
          <span className="visually-hidden">, reason </span>
          {reason}
        </span>
      ) : null}
    </span>
  );
}
