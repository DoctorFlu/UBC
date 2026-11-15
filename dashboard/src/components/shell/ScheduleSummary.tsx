"use client";

import { CATEGORY_LABELS, categoriesFromMask } from "@mandate/shared";
import Link from "next/link";
import { useId } from "react";

import { LimitMeter } from "@/components/ui/LimitMeter";
import { formatUsdCents } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";

import styles from "./Shell.module.css";

/** The mandate in force as a compact schedule: the two rated rules and the fixed ones. */
export function ScheduleSummary() {
  const titleId = useId();
  const chain = useSnapshot().chain;
  const rules = chain?.rules ?? null;
  return (
    <section className={styles.schedule} aria-labelledby={titleId}>
      <div className={styles.scheduleHead}>
        <h2 id={titleId} className={styles.scheduleTitle}>
          {chain && rules ? `Mandate v${chain.policyVersion.toString()}` : "No mandate yet"}
        </h2>
        <Link href="/mandate" className={styles.scheduleLink}>
          {rules ? "Rules" : "Set one"}
        </Link>
      </div>
      {chain && rules ? (
        <>
          <LimitMeter
            compact
            label="Budget"
            usedCents={chain.committedCents}
            limitCents={rules.budgetCents}
          />
          {rules.dailyLossCents > 0 ? (
            <LimitMeter
              compact
              label="Daily loss"
              usedCents={chain.lossTodayCents}
              limitCents={rules.dailyLossCents}
              usedWord="lost today"
            />
          ) : null}
          <dl className={styles.scheduleRows}>
            <dt>Max trade</dt>
            <dd>{formatUsdCents(rules.maxTradeCents)}</dd>
            <dt>Approval above</dt>
            <dd>{rules.approvalAboveCents === 0 ? "Never" : formatUsdCents(rules.approvalAboveCents)}</dd>
            <dt>Markets</dt>
            <dd>
              {categoriesFromMask(rules.allowedCategories)
                .map((category) => CATEGORY_LABELS[category])
                .join(", ") || "None"}
            </dd>
          </dl>
        </>
      ) : (
        <p className={styles.scheduleEmpty}>
          The agent can&apos;t trade until you sign its first set of rules.
        </p>
      )}
    </section>
  );
}
