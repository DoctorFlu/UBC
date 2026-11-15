import { Inbox } from "lucide-react";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { MarketName, OrderSummary } from "@/components/domain/Intent";
import { RulesSchedule } from "@/components/domain/RulesSchedule";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import type { Agent, Intent, Mandate, MandateUsage } from "@/lib/domain";
import { formatDateUtc, formatTimeUtc, formatUsdCents } from "@/lib/format";

import styles from "./overview.module.css";

export interface OverviewData {
  agent: Agent;
  mandate: Mandate;
  usage: MandateUsage;
  intents: readonly Intent[];
}

const recentColumns: readonly Column<Intent>[] = [
  { key: "time", header: "Time", cell: (intent) => formatTimeUtc(intent.createdAt), nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName market={intent.market} />,
    role: "primary",
  },
  { key: "order", header: "Order", cell: (intent) => <OrderSummary intent={intent} />, nowrap: true },
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
];

export function OverviewView({ agent, mandate, usage, intents }: OverviewData) {
  const held = intents.filter((intent) => intent.status === "held");
  const recent = intents.slice(0, 5);
  const heldLine =
    held.length === 0
      ? "Nothing is waiting for you."
      : `${held.length.toString()} ${held.length === 1 ? "intent needs" : "intents need"} your approval.`;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Overview"
        description={`${agent.name} is trading under mandate v${mandate.version.toString()}. ${heldLine}`}
        meta={
          <>
            <HexValue label="Agent" value={agent.address} kind="address" />
            <span>
              Mandate set {formatDateUtc(mandate.updatedAt)}, {formatTimeUtc(mandate.updatedAt)}
            </span>
          </>
        }
      />

      <div className={styles.board}>
        <Card
          className={styles.schedule}
          title="Rules in force"
          description="Each rule's limit and how much of it today's trading has used."
          actions={<ArrowLink href="/mandate">Mandate</ArrowLink>}
        >
          <RulesSchedule mandate={mandate} usage={usage} />
        </Card>

        <Card
          className={styles.held}
          tone={held.length > 0 ? "attention" : "default"}
          title="Needs your approval"
          description={`Intents above ${formatUsdCents(mandate.approvalThresholdCents)} wait here for your signature.`}
        >
          {held.length === 0 ? (
            <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title="Nothing waiting">
              When the agent sends an intent above the approval threshold, it appears here.
            </EmptyState>
          ) : (
            <ul className={styles.heldList}>
              {held.map((intent) => (
                <li key={intent.id} className={styles.heldItem}>
                  <div className={styles.heldHead}>
                    <MarketName market={intent.market} />
                    <Money cents={intent.notionalCents} className={styles.heldAmount} />
                  </div>
                  <div className={styles.heldMeta}>
                    <OrderSummary intent={intent} />
                    <span>{formatTimeUtc(intent.createdAt)}</span>
                  </div>
                  <p className={styles.rationale}>{intent.rationale}</p>
                  <ApprovalActions intent={intent} block />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          className={styles.recent}
          title="Latest intents"
          padding="flush"
          actions={<ArrowLink href="/activity">All activity</ArrowLink>}
        >
          <Table
            caption="The five most recent intents and their verdicts"
            captionHidden
            columns={recentColumns}
            rows={recent}
            rowKey={(intent) => intent.id}
            rowTone={(intent) => (intent.status === "held" ? "attention" : undefined)}
            empty={
              <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title="No intents yet">
                Once Grok Bot is paired and sends its first intent, every verdict appears here as it lands
                onchain.
              </EmptyState>
            }
          />
        </Card>
      </div>
    </div>
  );
}
