import { LimitMeter } from "@/components/ui/LimitMeter";
import { type Mandate, type MandateUsage, type ReasonCode, categoryLabels } from "@/lib/domain";
import { formatUsdCents } from "@/lib/format";

import styles from "./domain.module.css";

function Trips({ count, code }: { count: number | undefined; code: ReasonCode }) {
  if (!count) return <span className={styles.tripsNone}>No trips today</span>;
  return (
    <span className={styles.trips} title={`Rejected with ${code}`}>
      {count} {count === 1 ? "trip" : "trips"} today
    </span>
  );
}

/**
 * The mandate as a panel schedule: one row per rule, each with its rating and today's load.
 * Rows mirror the contract's six rules; the kill switch is the isolator in the status strip.
 */
export function RulesSchedule({ mandate, usage }: { mandate: Mandate; usage: MandateUsage }) {
  return (
    <ol className={styles.schedule}>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Total budget</span>
          <span className={styles.circuitHelp}>All the agent may spend under this mandate.</span>
        </div>
        <LimitMeter label="Spent" usedCents={usage.budgetUsedCents} limitCents={mandate.totalBudgetCents} />
        <Trips count={usage.tripsToday.BUDGET_EXCEEDED} code="BUDGET_EXCEEDED" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Daily loss limit</span>
          <span className={styles.circuitHelp}>New intents stop once today&apos;s losses reach it.</span>
        </div>
        <LimitMeter
          label="Lost today"
          usedCents={usage.dailyLossCents}
          limitCents={mandate.dailyLossLimitCents}
          usedWord="of the limit"
        />
        <Trips count={usage.tripsToday.DAILY_LOSS_LIMIT} code="DAILY_LOSS_LIMIT" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Max order size</span>
          <span className={styles.circuitHelp}>The largest single intent allowed.</span>
        </div>
        <LimitMeter
          label="Largest today"
          usedCents={usage.largestOrderTodayCents}
          limitCents={mandate.maxOrderCents}
          usedWord="of the max"
        />
        <Trips count={usage.tripsToday.MAX_ORDER_SIZE} code="MAX_ORDER_SIZE" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Approval threshold</span>
          <span className={styles.circuitHelp}>Larger intents wait for your signature.</span>
        </div>
        <div className={styles.plate}>
          <span className={styles.plateValue}>{formatUsdCents(mandate.approvalThresholdCents)}</span>
          <span className={styles.plateNote}>{usage.heldToday} held for you today</span>
        </div>
        <span className={styles.tripsNone}>Holds, never rejects</span>
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Allowed markets</span>
          <span className={styles.circuitHelp}>Categories the agent may trade.</span>
        </div>
        <div className={styles.plate}>
          <span className={styles.categories}>
            {mandate.allowedCategories.map((category) => (
              <span key={category} className={styles.category}>
                {categoryLabels[category]}
              </span>
            ))}
          </span>
        </div>
        <Trips count={usage.tripsToday.CATEGORY_NOT_ALLOWED} code="CATEGORY_NOT_ALLOWED" />
      </li>
    </ol>
  );
}
