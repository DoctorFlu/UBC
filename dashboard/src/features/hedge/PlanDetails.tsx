"use client";

import type { HedgePlan, UncoveredSlice } from "@mandate/planner";
import { TriangleAlert } from "lucide-react";

import { Money } from "@/components/ui/Money";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { formatContractsHundredths, formatUsdCents } from "@/lib/format";

import styles from "./hedge.module.css";
import { notCoveredSentence } from "./not-covered";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

/** Why a slice of the range is not bought, in the owner's words. */
const SHORTFALL_REASONS: Partial<Record<UncoveredSlice["code"], string>> = {
  cost_cap_reached: "the spend cap ran out",
  budget_exhausted: "the mandate's remaining budget ran out",
  trade_cap_too_small: "the max trade size is too small for one contract",
  thin_depth: "too few contracts were on offer",
  no_price: "nobody was selling that contract",
  market_not_open: "that market was not open",
  below_minimum: "the order was below Gemini's minimum",
  category_not_allowed: "the mandate does not allow crypto markets",
};

/** Cost, payout, range, contracts, what is left exposed and the planner's warnings, for one plan. */
export function PlanDetails({ plan, settles }: { plan: HedgePlan; settles: string | null }) {
  const range = plan.totals.protectedRange;
  const lowest = plan.rungs.at(-1);
  const uncovered = plan.uncovered.filter((slice) => slice.shortfallCents > 0);
  return (
    <div className={styles.planDetails}>
      <StatGroup>
        <Stat
          label="Costs"
          value={<Money cents={plan.totals.costCents} />}
          hint={`${plan.totals.orderCount.toString()} ${plan.totals.orderCount === 1 ? "order" : "orders"} at their limits`}
        />
        <Stat
          label="Pays at most"
          value={<Money cents={plan.totals.maxPayoutCents} />}
          hint={lowest ? `If ${plan.asset} ends below ${usd(lowest.strikeCents)}` : "Nothing is bought"}
        />
        <Stat
          label="Contracts"
          value={<span className="num">{formatContractsHundredths(plan.totals.contractsHundredths)}</span>}
          hint={settles ? `Settle ${settles}` : "$1 each if they pay"}
        />
      </StatGroup>
      <dl className={styles.facts}>
        <div>
          <dt>Protects</dt>
          <dd className="num">
            {range
              ? `From ${usd(range.fromCents)} down to ${usd(range.toCents)}`
              : "Nothing: no contracts bought"}
          </dd>
        </div>
        <div>
          <dt>Spot when planned</dt>
          <dd className="num">{usd(plan.spotCents)}</dd>
        </div>
        <div>
          <dt>Holding</dt>
          <dd className="num">
            {plan.holdingQuantity} {plan.asset}
          </dd>
        </div>
      </dl>
      <div className={styles.notCovered} data-testid="not-covered">
        <p>
          <strong>Not covered.</strong> {notCoveredSentence(plan)}
        </p>
        {uncovered.length > 0 ? (
          <ul className={styles.uncovered}>
            {uncovered.map((slice) => (
              <li
                key={`${slice.code}:${slice.fromCents.toString()}:${slice.toCents.toString()}`}
                className="num"
              >
                {usd(slice.fromCents)} to {usd(slice.toCents)}: {formatUsdCents(slice.shortfallCents)} of
                planned payout not bought, because {SHORTFALL_REASONS[slice.code] ?? "of a warning below"}.
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {plan.warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label="Planner warnings" data-testid="plan-warnings">
          {plan.warnings.map((warning) => (
            <li key={`${warning.code}:${warning.message}`}>
              <TriangleAlert aria-hidden />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
