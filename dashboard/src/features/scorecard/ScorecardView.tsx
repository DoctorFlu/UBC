import { MarketName } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { type Agent, type Intent, type IntentStatus, type Mandate, categoryLabels } from "@/lib/domain";
import {
  formatCount,
  formatDateUtc,
  formatPercentBps,
  formatTimeUtc,
  formatUsdCents,
  shareBps,
} from "@/lib/format";

import styles from "./scorecard.module.css";

export interface ScorecardData {
  agent: Agent;
  mandate: Mandate;
  intents: readonly Intent[];
  ownerApprovals: number;
  hedgeOutcomeCents: number;
}

const columns: readonly Column<Intent>[] = [
  { key: "time", header: "Time", cell: (intent) => formatTimeUtc(intent.createdAt), nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName market={intent.market} />,
    role: "primary",
  },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) => <Money cents={intent.notionalCents} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "verdict",
    header: "Verdict",
    cell: (intent) => <StatusChip status={intent.status} reasonCode={intent.reasonCode} />,
  },
  {
    key: "tx",
    header: "Transaction",
    cell: (intent) => <HexValue value={intent.txHash} kind="tx" />,
    nowrap: true,
  },
];

/** The agent's record as anyone can check it: every verdict is an onchain event. */
export function ScorecardView({ agent, mandate, intents, ownerApprovals, hedgeOutcomeCents }: ScorecardData) {
  const tally = (statuses: readonly IntentStatus[]) =>
    intents.filter((intent) => statuses.includes(intent.status)).length;
  const passed = tally(["approved", "filled", "unfilled"]);
  const rejected = tally(["rejected"]);
  const held = tally(["held"]);
  const decided = passed + rejected;

  return (
    <div className={styles.view}>
      <PageHeader
        title={agent.name}
        description={`An AI agent trading prediction markets under an onchain mandate since ${formatDateUtc(agent.pairedAt)}. Its owner sets the limits; a contract on Arc enforces them.`}
        meta={
          <>
            <HexValue label="Agent" value={agent.address} kind="address" />
            <HexValue label="Owner" value={agent.owner} kind="address" />
          </>
        }
      />

      <Card>
        <StatGroup>
          <Stat label="Intents sent" value={formatCount(intents.length)} />
          <Stat
            label="Inside the mandate"
            value={
              decided > 0 ? formatPercentBps(shareBps(passed, decided), { fractionDigits: 0 }) : "None yet"
            }
            hint={`${formatCount(passed)} of ${formatCount(decided)} decided`}
          />
          <Stat label="Blocked by the contract" value={formatCount(rejected)} />
          <Stat
            label="Waiting for the owner"
            value={formatCount(held)}
            hint={`${formatCount(ownerApprovals)} signed so far`}
          />
          <Stat
            label="Hedge result"
            value={<Money cents={hedgeOutcomeCents} sign="always" />}
            hint="Paid out after cost"
          />
        </StatGroup>
      </Card>

      <Card
        title="The mandate"
        description={`Version ${mandate.version.toString()}, enforced by the Policy contract on Arc.`}
        headingLevel={2}
      >
        <StatGroup>
          <Stat size="sm" label="Total budget" value={formatUsdCents(mandate.totalBudgetCents)} />
          <Stat size="sm" label="Max order" value={formatUsdCents(mandate.maxOrderCents)} />
          <Stat size="sm" label="Owner signs above" value={formatUsdCents(mandate.approvalThresholdCents)} />
          <Stat size="sm" label="Daily loss limit" value={formatUsdCents(mandate.dailyLossLimitCents)} />
          <Stat
            size="sm"
            label="Markets"
            value={mandate.allowedCategories.map((category) => categoryLabels[category]).join(", ")}
          />
        </StatGroup>
      </Card>

      <Card title="Recent verdicts" padding="flush" headingLevel={2}>
        <Table
          caption="Recent intents and the contract's verdicts"
          captionHidden
          columns={columns}
          rows={intents}
          rowKey={(intent) => intent.id}
          empty={
            <EmptyState plain title="No intents yet">
              This agent has not sent an intent under its mandate.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
