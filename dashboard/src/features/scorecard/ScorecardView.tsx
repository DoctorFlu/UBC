import { CATEGORY_LABELS, type IntentView, categoriesFromMask } from "@mandate/shared";
import type { Address } from "viem";

import { MarketName, amountLabel, IntentVerdict } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import {
  formatCount,
  formatDateUtc,
  formatPercentBps,
  formatTimeUtc,
  formatUsdCents,
  formatUsdCentsDelta,
  shareBps,
} from "@/lib/format";
import { countByStatus, isoFromUnix, newestFirst, ownerApprovals } from "@/lib/live/derive";
import type { ChainView } from "@/lib/live/types";

import styles from "./scorecard.module.css";

export interface ScorecardData {
  agent: { address: Address; name: string; pairedAt: string | null };
  owner: Address;
  chain: ChainView;
}

const RECENT = 20;

const columns: readonly Column<IntentView>[] = [
  {
    key: "time",
    header: "Time",
    cell: (intent) => (
      <span className={styles.when}>
        <span>{formatTimeUtc(isoFromUnix(intent.proposedAt))}</span>
        <span className={styles.date}>{formatDateUtc(isoFromUnix(intent.proposedAt))}</span>
      </span>
    ),
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName symbol={intent.market} category={intent.category} />,
    role: "primary",
  },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) =>
      intent.amountCents === null ? amountLabel(intent) : <Money cents={intent.amountCents} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "verdict",
    header: "Verdict",
    cell: (intent) => <IntentVerdict intent={intent} />,
  },
  {
    key: "tx",
    header: "Transaction",
    cell: (intent) => <HexValue value={intent.decidedTxHash ?? intent.proposedTxHash} kind="tx" />,
    nowrap: true,
  },
];

/** The agent's record as anyone can check it: every number is read from the Policy contract's events. */
export function ScorecardView({ agent, owner, chain }: ScorecardData) {
  const intents = chain.intents;
  const passed = countByStatus(intents, ["approved", "executed", "failed"]);
  const rejected = countByStatus(intents, ["rejected"]);
  const held = countByStatus(intents, ["needs_approval"]);
  const decided = passed + rejected;
  const rules = chain.rules;
  const markets = rules
    ? categoriesFromMask(rules.allowedCategories)
        .map((category) => CATEGORY_LABELS[category])
        .join(", ") || "None"
    : null;

  return (
    <div className={styles.view}>
      <PageHeader
        title={agent.name}
        description={`An AI agent trading prediction markets under an onchain mandate${agent.pairedAt ? ` since ${formatDateUtc(agent.pairedAt)}` : ""}. Its owner sets the limits; a contract on Arc enforces them.`}
        meta={
          <>
            <HexValue label="Agent" value={agent.address} kind="address" />
            <HexValue label="Owner" value={owner} kind="address" />
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
            hint={`${formatCount(ownerApprovals(chain))} signed so far`}
          />
          <Stat
            label="Realized result"
            value={<span className="num">{formatUsdCentsDelta(chain.realizedPnlCents)}</span>}
            hint="Profit and loss of recorded fills"
          />
        </StatGroup>
      </Card>

      <Card
        title="The mandate"
        description={
          rules
            ? `Version ${chain.policyVersion.toString()}, enforced by the Policy contract on Arc.`
            : "The owner has not signed a mandate yet, so the contract rejects every intent."
        }
        headingLevel={2}
      >
        {rules ? (
          <StatGroup>
            <Stat size="sm" label="Total budget" value={formatUsdCents(rules.budgetCents)} />
            <Stat size="sm" label="Max trade" value={formatUsdCents(rules.maxTradeCents)} />
            <Stat
              size="sm"
              label="Owner signs above"
              value={rules.approvalAboveCents === 0 ? "Never" : formatUsdCents(rules.approvalAboveCents)}
            />
            <Stat
              size="sm"
              label="Daily loss limit"
              value={rules.dailyLossCents === 0 ? "Off" : formatUsdCents(rules.dailyLossCents)}
            />
            <Stat size="sm" label="Markets" value={markets} />
          </StatGroup>
        ) : null}
      </Card>

      <Card title="Recent verdicts" padding="flush" headingLevel={2}>
        <Table
          caption="Recent intents and the contract's verdicts, newest first"
          captionHidden
          columns={columns}
          rows={newestFirst(chain).slice(0, RECENT)}
          rowKey={(intent) => intent.id.toString()}
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
