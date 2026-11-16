import { FlaskConical } from "lucide-react";

import { cx } from "@/lib/cx";

import styles from "./domain.module.css";

/**
 * Marks a fill recorded on the local devchain, where the executor is a simulator: the fill is real
 * onchain, but no exchange ever saw the order.
 */
export function SimulatedFill({ className }: { className?: string }) {
  return (
    <span
      className={cx(styles.simulated, className)}
      title="Recorded by the local devchain's simulated executor; no exchange saw this order."
      data-testid="simulated-fill"
    >
      <FlaskConical aria-hidden strokeWidth={2} />
      Simulated fill
    </span>
  );
}
