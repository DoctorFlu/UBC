import type { CSSProperties } from "react";

import { MarketName } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import type { HedgePlan, Holding, LadderRung } from "@/lib/domain";
import { formatContractPrice, formatCount, formatUsdCents, formatUsdCentsDelta } from "@/lib/format";

import styles from "./hedge.module.css";

export interface HedgeData {
  holdings: readonly Holding[];
  ladder: readonly LadderRung[];
  plan: HedgePlan;
}

const usd = (dollars: number) => formatUsdCents(dollars * 100, { trimWholeCents: true });

const ladderColumns: readonly Column<LadderRung>[] = [
  { key: "strike", header: "Pays if BTC ends below", cell: (rung) => usd(rung.strike), nowrap: true },
  { key: "market", header: "Market", cell: (rung) => <MarketName market={rung.market} />, role: "primary" },
  {
    key: "ask",
    header: "Ask",
    cell: (rung) => formatContractPrice(rung.askCents),
    align: "end",
    nowrap: true,
  },
  { key: "contracts", header: "Contracts", cell: (rung) => formatCount(rung.plannedContracts), align: "end" },
  {
    key: "cost",
    header: "Cost",
    cell: (rung) => <Money cents={rung.askCents * rung.plannedContracts} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "pays",
    header: "Pays out",
    cell: (rung) => <Money cents={rung.plannedContracts * 100} />,
    align: "end",
    nowrap: true,
  },
];

interface Band {
  label: string;
  netCents: number;
}

/**
 * Net hedge result at expiry for each price band between strikes. A "BTC below K" contract pays
 * $1 when BTC settles under K, so a band pays every rung whose strike is above it.
 */
function payoffBands(ladder: readonly LadderRung[], costCents: number): Band[] {
  const rungs = [...ladder].sort((a, b) => b.strike - a.strike);
  const bands: Band[] = [];
  let contracts = 0;
  rungs.forEach((rung, index) => {
    const above =
      index === 0
        ? `Above ${usd(rung.strike)}`
        : `${usd(rung.strike)} to ${usd(rungs[index - 1]?.strike ?? 0)}`;
    bands.push({ label: above, netCents: contracts * 100 - costCents });
    contracts += rung.plannedContracts;
  });
  const lowest = rungs.at(-1);
  if (lowest) bands.push({ label: `Below ${usd(lowest.strike)}`, netCents: contracts * 100 - costCents });
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

export function HedgeView({ holdings, ladder, plan }: HedgeData) {
  const btc = holdings.find((holding) => holding.asset === "BTC");
  const bands = payoffBands(ladder, plan.costCents);

  return (
    <div className={styles.view}>
      <PageHeader
        title="Hedge"
        description="Protection for the BTC you hold, bought as a ladder of “BTC below” contracts that pay $1 each if BTC ends under the strike."
      />

      <div className={styles.top}>
        <Card title="What you hold" headingLevel={2}>
          {btc ? (
            <StatGroup>
              <Stat
                label="BTC"
                value={btc.quantity}
                hint={`at ${formatUsdCents(btc.priceCents, { trimWholeCents: true })}`}
              />
              <Stat label="Value" value={<Money cents={btc.valueCents} />} />
            </StatGroup>
          ) : (
            <EmptyState plain title="No holdings yet">
              Add the BTC you want protected and the agent sizes a ladder to it.
            </EmptyState>
          )}
        </Card>
        <Card title="The plan" headingLevel={2}>
          <StatGroup>
            <Stat label="Costs" value={<Money cents={plan.costCents} />} hint="At today's asks" />
            <Stat
              label="Pays at most"
              value={<Money cents={plan.maxPayoutCents} />}
              hint={`If BTC ends below ${usd(ladder.at(-1)?.strike ?? 0)}`}
            />
            <Stat label="Starts paying" value={`Below ${usd(plan.coveredBelowStrike)}`} hint="On Dec 31" />
          </StatGroup>
          <p className={styles.notCovered}>
            <strong>Not covered.</strong> {plan.notCovered}
          </p>
        </Card>
      </div>

      <Card
        title="Payoff on Dec 31"
        description="The ladder's result after its cost, by where BTC settles. Your BTC itself gains or loses on top of this."
        headingLevel={2}
      >
        {ladder.length > 0 ? (
          <PayoffBands bands={bands} />
        ) : (
          <EmptyState plain title="No ladder yet">
            Once the agent proposes a ladder, its payoff by price appears here.
          </EmptyState>
        )}
      </Card>

      <Card title="Ladder" padding="flush" headingLevel={2}>
        <Table
          caption="Hedge ladder rungs, highest strike first"
          captionHidden
          columns={ladderColumns}
          rows={ladder}
          rowKey={(rung) => rung.market.symbol}
          empty={
            <EmptyState plain title="No rungs">
              The agent has not proposed a ladder yet.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
