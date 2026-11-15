import { type ReasonCode, type StatusKind, reasonLabels } from "@/lib/domain";
import { cx } from "@/lib/cx";

import styles from "./StatusChip.module.css";

export const statusLabels: Record<StatusKind, string> = {
  approved: "Approved",
  held: "Held",
  rejected: "Rejected",
  filled: "Filled",
  unfilled: "Unfilled",
  paused: "Paused",
};

/** What each status means, for tooltips and screen readers. */
export const statusDescriptions: Record<StatusKind, string> = {
  approved: "The Policy contract approved this intent.",
  held: "Waiting for the owner's signature.",
  rejected: "The Policy contract rejected this intent.",
  filled: "Approved and filled on Gemini.",
  unfilled: "Approved, but the order did not fill.",
  paused: "The mandate is paused; new intents are rejected.",
};

export interface StatusChipProps {
  status: StatusKind;
  /** The contract's reason code, shown after the label (rejected and held). */
  reasonCode?: ReasonCode | undefined;
  className?: string;
}

/** The one way a verdict is shown anywhere in the console: a lamp, a word, and the reason code. */
export function StatusChip({ status, reasonCode, className }: StatusChipProps) {
  const title = reasonCode
    ? `${statusDescriptions[status]} ${reasonLabels[reasonCode]}.`
    : statusDescriptions[status];
  return (
    <span className={cx(styles.chip, styles[status], className)} title={title}>
      <span className={styles.lamp} aria-hidden />
      <span>{statusLabels[status]}</span>
      {reasonCode ? (
        <span className={styles.code}>
          <span className="visually-hidden">, reason </span>
          {reasonCode}
        </span>
      ) : null}
    </span>
  );
}
