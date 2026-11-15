import Link from "next/link";
import { useId } from "react";

import { LimitMeter } from "@/components/ui/LimitMeter";
import { categoryLabels } from "@/lib/domain";
import { formatUsdCents } from "@/lib/format";
import { mandate, usage } from "@/mock";

import styles from "./Shell.module.css";

/** The current mandate as a compact schedule: the three rated rules and the two fixed ones. */
export function ScheduleSummary() {
  const titleId = useId();
  return (
    <section className={styles.schedule} aria-labelledby={titleId}>
      <div className={styles.scheduleHead}>
        <h2 id={titleId} className={styles.scheduleTitle}>
          Mandate v{mandate.version}
        </h2>
        <Link href="/mandate" className={styles.scheduleLink}>
          Rules
        </Link>
      </div>
      <LimitMeter
        compact
        label="Budget"
        usedCents={usage.budgetUsedCents}
        limitCents={mandate.totalBudgetCents}
      />
      <LimitMeter
        compact
        label="Daily loss"
        usedCents={usage.dailyLossCents}
        limitCents={mandate.dailyLossLimitCents}
        usedWord="lost today"
      />
      <dl className={styles.scheduleRows}>
        <dt>Max order</dt>
        <dd>{formatUsdCents(mandate.maxOrderCents)}</dd>
        <dt>Approval above</dt>
        <dd>{formatUsdCents(mandate.approvalThresholdCents)}</dd>
        <dt>Markets</dt>
        <dd>{mandate.allowedCategories.map((category) => categoryLabels[category]).join(", ")}</dd>
      </dl>
    </section>
  );
}
