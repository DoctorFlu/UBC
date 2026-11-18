"use client";

import type { CoverRung } from "@mandate/planner";
import type { IntentView } from "@mandate/shared";
import { Meter, MeterIndicator, MeterTrack } from "@ui-sdk/react/meter";

import { Card } from "@/components/ui/Card";
import { type Column, Table } from "@/components/ui/Table";
import { Advanced } from "@/lib/advanced/Advanced";
import { cx } from "@/lib/cx";
import { formatContractsHundredths, formatPercentBps, formatUsdCents } from "@/lib/format";
import type { AgentPlanView, LadderQuotes } from "@/lib/hedge/types";
import { describeMarket } from "@/lib/markets";

import styles from "./CoverNow.module.css";
import { coverNow, coverSentence } from "./cover-now";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

const rungColumns: readonly Column<CoverRung>[] = [
  {
    key: "strike",
    header: "Pays if below",
    cell: (r) => <span className="num">{usd(r.strikeCents)}</span>,
    nowrap: true,
  },
  {
    key: "goal",
    header: "Goal",
    cell: (r) => <span className="num">{formatContractsHundredths(r.targetHundredths)} NO</span>,
    align: "end",
    nowrap: true,
  },
  {
    key: "held",
    header: "Held",
    cell: (r) => <span className="num">{formatContractsHundredths(r.heldHundredths)} NO</span>,
    align: "end",
    nowrap: true,
  },
  {
    key: "missing",
    header: "Missing",
    cell: (r) => <span className="num">{formatContractsHundredths(r.missingHundredths)} NO</span>,
    align: "end",
    nowrap: true,
  },
];

/**
 * How much of the holding the contracts already held cover now, against the goal of the agent's latest
 * plan, in plain words. Advanced view adds the numbers per strike. The server's MCP tools answer the
 * agent with the same planner function, so the console and the agent never disagree.
 */
export function CoverNowCard({
  view,
  holdingQuantity,
  quotes,
  intents,
}: {
  view: AgentPlanView;
  holdingQuantity: string | null;
  quotes: LadderQuotes | null;
  intents: readonly IntentView[];
}) {
  const cover = quotes ? coverNow({ plan: view.plan, holdingQuantity, quotes, intents }) : null;
  const assessment = cover?.assessment ?? null;
  const settles = describeMarket(view.plan.rungs[0]?.instrumentSymbol ?? "").settles;
  const bps = assessment?.coverBps ?? 0;
  return (
    <Card title="Cover now" headingLevel={2}>
      <div className={styles.cover} data-testid="cover-now" data-state={assessment?.state ?? "unknown"}>
        <p className={styles.sentence} role="status">
          {assessment
            ? coverSentence(assessment, settles)
            : "Cover cannot be measured now: Gemini's market data for this ladder is unavailable."}
        </p>
        {assessment && assessment.measuredBelowCents !== null ? (
          <Meter
            className={cx(styles.meter, assessment.state === "met" && styles.met)}
            min={0}
            max={10_000}
            value={Math.min(bps, 10_000)}
            getValueLabel={() => `${formatPercentBps(bps, { fractionDigits: 0 })} covered`}
            aria-label="Share of the goal covered"
          >
            <MeterTrack className={styles.track}>
              <MeterIndicator className={styles.fill} />
            </MeterTrack>
          </Meter>
        ) : null}
        {assessment && assessment.measuredBelowCents !== null ? (
          <Advanced>
            <p className={styles.detail}>
              Measured below {usd(assessment.measuredBelowCents)}: held {usd(assessment.heldPayoutCents)} (
              {usd(assessment.heldByState.filled)} filled, {usd(assessment.heldByState.awaiting_fill)} waiting
              to fill, {usd(assessment.heldByState.awaiting_owner)} waiting for your approval) against a goal
              of {usd(assessment.targetPayoutCents)}. A shortfall up to {usd(assessment.toleranceCents)} (2%)
              counts as covered. {cover?.positions.length ?? 0} intents on {assessment.eventTicker} are
              counted.
            </p>
            <Table
              caption={`Cover per strike on ${assessment.eventTicker}`}
              captionHidden
              columns={rungColumns}
              rows={assessment.rungs}
              rowKey={(r) => r.instrumentSymbol}
            />
          </Advanced>
        ) : null}
      </div>
    </Card>
  );
}
