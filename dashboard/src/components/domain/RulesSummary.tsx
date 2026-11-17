import { type PolicyRules, type ReasonCode, categoriesFromMask, CATEGORY_LABELS } from "@mandate/shared";
import type { ReactNode } from "react";

import { LimitMeter } from "@/components/ui/LimitMeter";
import { formatUsdCents } from "@/lib/format";
import type { TodayUsage } from "@/lib/live/derive";

import styles from "./RulesSummary.module.css";

export interface RulesSummaryProps {
  rules: PolicyRules;
  committedCents: number;
  lossTodayCents: number;
  usage: TodayUsage;
}

function Row({
  name,
  value,
  blocked,
  children,
}: {
  name: string;
  value?: ReactNode;
  blocked: number;
  children?: ReactNode;
}) {
  return (
    <li className={styles.row}>
      {children ?? (
        <div className={styles.line}>
          <span className={styles.name}>{name}</span>
          <span className={styles.value}>{value}</span>
        </div>
      )}
      {blocked > 0 ? <span className={styles.blocked}>Blocked {blocked.toString()} today</span> : null}
    </li>
  );
}

/**
 * The rules in force at a glance: the two running totals as bars, the rest as plain values, and a
 * "Blocked today" note only on a rule that stopped something. The full schedule is in Advanced view.
 */
export function RulesSummary({ rules, committedCents, lossTodayCents, usage }: RulesSummaryProps) {
  const blocked = (reason: ReasonCode) => usage.blockedByReason[reason] ?? 0;
  const categories = categoriesFromMask(rules.allowedCategories);
  return (
    <ul className={styles.rules} data-testid="rules-summary">
      <Row name="Budget" blocked={blocked("over budget")}>
        <LimitMeter label="Budget" usedCents={committedCents} limitCents={rules.budgetCents} compact />
      </Row>
      <Row name="Daily loss limit" value="Off" blocked={blocked("daily loss limit reached")}>
        {rules.dailyLossCents === 0 ? undefined : (
          <LimitMeter
            label="Daily loss limit"
            usedCents={lossTodayCents}
            limitCents={rules.dailyLossCents}
            usedWord="of the limit"
            compact
          />
        )}
      </Row>
      <Row
        name="Max trade size"
        value={formatUsdCents(rules.maxTradeCents)}
        blocked={blocked("over max trade size")}
      />
      <Row
        name="Approval above"
        value={rules.approvalAboveCents === 0 ? "Never asks" : formatUsdCents(rules.approvalAboveCents)}
        blocked={0}
      />
      <Row
        name="Markets"
        value={
          categories.length === 0
            ? "None allowed"
            : categories.map((category) => CATEGORY_LABELS[category]).join(", ")
        }
        blocked={blocked("category not allowed")}
      />
    </ul>
  );
}
