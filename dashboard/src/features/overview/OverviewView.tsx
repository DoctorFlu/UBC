"use client";

import type { IntentView } from "@mandate/shared";
import { Inbox } from "lucide-react";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { IntentLink, MarketName, OrderSummary } from "@/components/domain/Intent";
import { RulesSchedule } from "@/components/domain/RulesSchedule";
import { ChainUnavailable, NoPolicyYet } from "@/components/states/ChainStates";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { formatDateUtc, formatTimeUtc, formatUsdCents } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import {
  agentName,
  isoFromUnix,
  newestFirst,
  sealedReasonText,
  todayUsage,
  waitingForApproval,
} from "@/lib/live/derive";
import type { ConsoleSnapshot } from "@/lib/live/types";

import styles from "./overview.module.css";

const recentColumns: readonly Column<IntentView>[] = [
  { key: "id", header: "Intent", cell: (intent) => <IntentLink id={intent.id} />, nowrap: true },
  {
    key: "time",
    header: "Time",
    cell: (intent) => formatTimeUtc(isoFromUnix(intent.proposedAt)),
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName symbol={intent.market} />,
    role: "primary",
  },
  { key: "order", header: "Order", cell: (intent) => <OrderSummary intent={intent} />, nowrap: true },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) => (intent.amountCents === null ? "Unknown" : <Money cents={intent.amountCents} />),
    align: "end",
    nowrap: true,
  },
  {
    key: "verdict",
    header: "Verdict",
    cell: (intent) => <StatusChip status={intent.status} reason={intent.reason} />,
  },
];

/** The owner's first screen: rules in force with today's load, what waits for them, and the latest verdicts. */
export function OverviewView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Overview" />;

  const name = agentName(snapshot);
  const waiting = waitingForApproval(chain);
  const recent = newestFirst(chain).slice(0, 5);
  const rules = chain.rules;
  const waitingLine =
    waiting.length === 0
      ? "Nothing is waiting for you."
      : `${waiting.length.toString()} ${waiting.length === 1 ? "intent needs" : "intents need"} your approval.`;
  const agent = snapshot.contract?.roles?.agent;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Overview"
        description={
          rules
            ? `${name} is trading under mandate v${chain.policyVersion.toString()}. ${waitingLine}`
            : `${name} can't trade yet: the Policy contract has no mandate.`
        }
        meta={
          <>
            {agent ? <HexValue label="Agent" value={agent} kind="address" /> : null}
            {chain.policySetBy ? (
              <span>
                Mandate set {formatDateUtc(isoFromUnix(chain.policySetBy.timestamp))},{" "}
                {formatTimeUtc(isoFromUnix(chain.policySetBy.timestamp))}
              </span>
            ) : null}
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
          {rules ? (
            <RulesSchedule
              rules={rules}
              committedCents={chain.committedCents}
              lossTodayCents={chain.lossTodayCents}
              usage={todayUsage(chain)}
            />
          ) : (
            <NoPolicyYet />
          )}
        </Card>

        <Card
          className={styles.held}
          tone={waiting.length > 0 ? "attention" : "default"}
          title="Needs your approval"
          description={
            rules && rules.approvalAboveCents > 0
              ? `Intents above ${formatUsdCents(rules.approvalAboveCents)} wait here for your signature.`
              : "Intents above the approval threshold wait here for your signature."
          }
        >
          {waiting.length === 0 ? (
            <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title="Nothing waiting">
              When the agent sends an intent above the approval threshold, it appears here.
            </EmptyState>
          ) : (
            <ul className={styles.heldList}>
              {waiting.map((intent) => {
                const reason = sealedReasonText(chain, intent.id);
                return (
                  <li
                    key={intent.id}
                    className={styles.heldItem}
                    data-testid={`waiting-intent-${intent.id.toString()}`}
                  >
                    <div className={styles.heldHead}>
                      <MarketName symbol={intent.market} />
                      {intent.amountCents === null ? null : (
                        <Money cents={intent.amountCents} className={styles.heldAmount} />
                      )}
                    </div>
                    <div className={styles.heldMeta}>
                      <OrderSummary intent={intent} />
                      <span>
                        <IntentLink id={intent.id} /> · {formatTimeUtc(isoFromUnix(intent.proposedAt))}
                      </span>
                    </div>
                    {reason ? <p className={styles.rationale}>{reason}</p> : null}
                    <ApprovalActions intent={intent} block />
                  </li>
                );
              })}
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
            rowKey={(intent) => intent.id.toString()}
            rowTone={(intent) => (intent.status === "needs_approval" ? "attention" : undefined)}
            empty={
              <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title="No intents yet">
                Once the agent sends its first intent, every verdict appears here as it lands onchain.
              </EmptyState>
            }
          />
        </Card>
      </div>
    </div>
  );
}
