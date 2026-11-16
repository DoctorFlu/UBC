import { type PolicyRules, type ReasonCode, categoriesFromMask, CATEGORY_LABELS } from "@mandate/shared";

import { LimitMeter } from "@/components/ui/LimitMeter";
import { formatUsdCents } from "@/lib/format";
import type { TodayUsage } from "@/lib/live/derive";

import styles from "./domain.module.css";

function Blocked({ usage, reason }: { usage: TodayUsage; reason: ReasonCode }) {
  const count = usage.blockedByReason[reason] ?? 0;
  if (count === 0) return <span className={styles.blockedNone}>Nothing blocked today</span>;
  return (
    <span className={styles.blocked} title={`Rejected with "${reason}"`}>
      Blocked {count.toString()} today
    </span>
  );
}

export interface RulesScheduleProps {
  rules: PolicyRules;
  /** Lifetime spend committed against the budget, from the contract's events. */
  committedCents: number;
  lossTodayCents: number;
  usage: TodayUsage;
}

/**
 * The mandate as a panel schedule: one row per rule, each with its rating and today's load. Rows mirror
 * the contract's rules; the kill switch is the isolator in the status strip.
 */
export function RulesSchedule({ rules, committedCents, lossTodayCents, usage }: RulesScheduleProps) {
  const categories = categoriesFromMask(rules.allowedCategories);
  return (
    <ol className={styles.schedule}>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Budget</span>
          <span className={styles.circuitHelp}>
            All the agent may ever commit to buys under this contract.
          </span>
        </div>
        <LimitMeter label="Committed" usedCents={committedCents} limitCents={rules.budgetCents} />
        <Blocked usage={usage} reason="over budget" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Daily loss limit</span>
          <span className={styles.circuitHelp}>
            {rules.dailyLossCents === 0
              ? "Off: losses never stop new intents."
              : "New intents stop once today's realized losses reach it."}
          </span>
        </div>
        {rules.dailyLossCents === 0 ? (
          <div className={styles.plate}>
            <span className={styles.plateValue}>Off</span>
            <span className={styles.plateNote}>{formatUsdCents(lossTodayCents)} lost today</span>
          </div>
        ) : (
          <LimitMeter
            label="Lost today"
            usedCents={lossTodayCents}
            limitCents={rules.dailyLossCents}
            usedWord="of the limit"
          />
        )}
        <Blocked usage={usage} reason="daily loss limit reached" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Max trade size</span>
          <span className={styles.circuitHelp}>The largest single intent allowed.</span>
        </div>
        <LimitMeter
          label="Largest today"
          usedCents={usage.largestOrderCents}
          limitCents={rules.maxTradeCents}
          usedWord="of the max"
        />
        <Blocked usage={usage} reason="over max trade size" />
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Approval above</span>
          <span className={styles.circuitHelp}>Larger intents wait for your signature.</span>
        </div>
        <div className={styles.plate}>
          <span className={styles.plateValue}>
            {rules.approvalAboveCents === 0 ? "Never asks" : formatUsdCents(rules.approvalAboveCents)}
          </span>
          <span className={styles.plateNote}>{usage.heldForApproval.toString()} waited for you today</span>
        </div>
        <span className={styles.blockedNone}>Waits, never rejects</span>
      </li>
      <li className={styles.circuit}>
        <div className={styles.circuitName}>
          <span className={styles.circuitTitle}>Allowed markets</span>
          <span className={styles.circuitHelp}>Categories the agent may trade.</span>
        </div>
        <div className={styles.plate}>
          {categories.length === 0 ? (
            <span className={styles.plateNote}>None: every intent is rejected</span>
          ) : (
            <span className={styles.categories}>
              {categories.map((category) => (
                <span key={category} className={styles.category}>
                  {CATEGORY_LABELS[category]}
                </span>
              ))}
            </span>
          )}
        </div>
        <Blocked usage={usage} reason="category not allowed" />
      </li>
    </ol>
  );
}
