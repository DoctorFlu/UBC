"use client";

import type { HedgePlan, PlannedRung } from "@mandate/planner";
import type { CSSProperties } from "react";

import { MarketName } from "@/components/domain/Intent";
import { SampleDataNote } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { sampleHedgePlan } from "@/fixtures/samples";
import {
  formatContractPrice,
  formatDateUtc,
  formatTimeUtc,
  formatUsdCents,
  formatUsdCentsDelta,
} from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { describeMarket } from "@/lib/markets";

import styles from "./hedge.module.css";
import { HoldingsEditor } from "./HoldingsEditor";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

const ladderColumns: readonly Column<PlannedRung>[] = [
  { key: "strike", header: "Pays if BTC ends below", cell: (rung) => usd(rung.strikeCents), nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: (rung) => <MarketName symbol={rung.instrumentSymbol} />,
    role: "primary",
  },
  {
    key: "price",
    header: "Limit",
    cell: (rung) => formatContractPrice(rung.limitPriceCents),
    align: "end",
    nowrap: true,
  },
  { key: "contracts", header: "Contracts", cell: (rung) => rung.quantity, align: "end" },
  {
    key: "cost",
    header: "Cost",
    cell: (rung) => <Money cents={rung.amountCents} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "pays",
    header: "Pays out",
    cell: (rung) => <Money cents={rung.payoutCents} />,
    align: "end",
    nowrap: true,
  },
];

interface Band {
  label: string;
  netCents: number;
}

/**
 * The hedge's result after its cost for each price band between strikes. A NO on "BTC $K or above" pays
 * $1 a contract when BTC settles under K, so a band collects every rung whose strike is above it.
 */
function payoffBands(plan: HedgePlan): Band[] {
  const rungs = [...plan.rungs].sort((a, b) => b.strikeCents - a.strikeCents);
  const bands: Band[] = [];
  let paysCents = 0;
  rungs.forEach((rung, index) => {
    const above = rungs[index - 1];
    bands.push({
      label: above
        ? `${usd(rung.strikeCents)} to ${usd(above.strikeCents)}`
        : `Above ${usd(rung.strikeCents)}`,
      netCents: paysCents - plan.totals.costCents,
    });
    paysCents += rung.payoutCents;
  });
  const lowest = rungs.at(-1);
  if (lowest)
    bands.push({ label: `Below ${usd(lowest.strikeCents)}`, netCents: paysCents - plan.totals.costCents });
  return bands;
}

function PayoffBands({ bands }: { bands: readonly Band[] }) {
  const maxGain = Math.max(0, ...bands.map((band) => band.netCents));
  const maxLoss = Math.max(0, ...bands.map((band) => -band.netCents));
  const span = maxGain + maxLoss || 1;
  const zero = (maxLoss / span) * 100;
  return (
    <dl className={styles.bands}>
      {bands.map((band) => {
        const width = (Math.abs(band.netCents) / span) * 100;
        const start = band.netCents < 0 ? zero - width : zero;
        return (
          <div key={band.label} className={styles.band}>
            <dt className={styles.bandLabel}>{band.label}</dt>
            <dd className={styles.bandValue} data-sign={band.netCents < 0 ? "loss" : "gain"}>
              {formatUsdCentsDelta(band.netCents)}
            </dd>
            <dd
              className={styles.bandTrack}
              aria-hidden
              style={
                {
                  "--zero": `${zero.toString()}%`,
                  "--start": `${start.toString()}%`,
                  "--width": `${width.toString()}%`,
                } as CSSProperties
              }
            >
              <span className={styles.bandBar} data-sign={band.netCents < 0 ? "loss" : "gain"} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** What the plan leaves exposed, in words: the first drop before the top rung, and anything under the floor. */
function notCovered(plan: HedgePlan): string {
  const range = plan.totals.protectedRange;
  if (!range) return "Nothing: the plan buys no contracts.";
  return `The first drop from ${usd(plan.spotCents)} to ${usd(range.fromCents)}, and any fall below ${usd(range.toCents)}, where the payout stops growing.`;
}

/**
 * The owner's holdings (real, signed by the owner) and the hedge the agent plans for them. The plan
 * and its payoff are sample data until the agent's plans are shown here (#17).
 */
export function HedgeView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { holdings, holdingsUpdatedAt, latestPlan } = snapshot.offchain;
  const plan = sampleHedgePlan;
  const settles = describeMarket(plan.rungs[0]?.instrumentSymbol ?? "").settles;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Hedge"
        description="Protection for the BTC you hold, bought as a ladder of “BTC below” contracts that pay $1 each if BTC ends under the strike."
      />

      <div className={styles.top}>
        <Card
          title="What you hold"
          description="The agent reads this to size a hedge. Saving it needs the owner wallet's signature."
          headingLevel={2}
        >
          <HoldingsEditor holdings={holdings} updatedAt={holdingsUpdatedAt} />
        </Card>
        <Card title="The plan" headingLevel={2}>
          <SampleDataNote issue="#17" className={styles.sampleNote}>
            {latestPlan
              ? `The agent stored plan ${latestPlan.planId.slice(0, 10)} for ${latestPlan.asset} on ${formatDateUtc(latestPlan.storedAt)} at ${formatTimeUtc(latestPlan.storedAt)}; this preview is a planner run on recorded quotes.`
              : "A real planner run on recorded quotes, not your holdings."}
          </SampleDataNote>
          <StatGroup>
            <Stat label="Costs" value={<Money cents={plan.totals.costCents} />} hint="At the quoted asks" />
            <Stat
              label="Pays at most"
              value={<Money cents={plan.totals.maxPayoutCents} />}
              hint={`If BTC ends below ${usd(plan.rungs.at(-1)?.strikeCents ?? 0)}`}
            />
            <Stat
              label="Starts paying"
              value={`Below ${usd(plan.rungs[0]?.strikeCents ?? 0)}`}
              hint={settles ? `On ${settles}` : undefined}
            />
          </StatGroup>
          <p className={styles.notCovered}>
            <strong>Not covered.</strong> {notCovered(plan)}
          </p>
        </Card>
      </div>

      <Card
        title={settles ? `Payoff on ${settles}` : "Payoff at settlement"}
        description="The ladder's result after its cost, by where BTC settles. Your BTC itself gains or loses on top of this."
        headingLevel={2}
      >
        {plan.rungs.length > 0 ? (
          <PayoffBands bands={payoffBands(plan)} />
        ) : (
          <EmptyState plain title="No ladder yet">
            Once the agent plans a ladder, its payoff by price appears here.
          </EmptyState>
        )}
      </Card>

      <Card title="Ladder" padding="flush" headingLevel={2}>
        <Table
          caption="Hedge ladder rungs, highest strike first"
          captionHidden
          columns={ladderColumns}
          rows={plan.rungs}
          rowKey={(rung) => rung.instrumentSymbol}
          empty={
            <EmptyState plain title="No rungs">
              The agent has not planned a ladder yet.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
