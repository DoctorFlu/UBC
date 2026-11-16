"use client";

import type { IntentView } from "@mandate/shared";

import { IntentLink, IntentVerdict, MarketName, OrderSummary, amountLabel } from "@/components/domain/Intent";
import { RulesSchedule } from "@/components/domain/RulesSchedule";
import { RulesSummary } from "@/components/domain/RulesSummary";
import { ChainUnavailable, NoPolicyYet } from "@/components/states/ChainStates";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { When } from "@/components/ui/When";
import { NeedsYou } from "@/features/approvals";
import { AdvancedSection, useAdvanced } from "@/lib/advanced/Advanced";
import { formatDateUtc, formatTimeUtc, formatUsdCents } from "@/lib/format";
import { needsOwner } from "@/lib/live/attention";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { agentName, isoFromUnix, newestFirst, todayUsage } from "@/lib/live/derive";
import type { ConsoleSnapshot } from "@/lib/live/types";

import styles from "./home.module.css";

const timeColumn: Column<IntentView> = {
  key: "time",
  header: "Time",
  cell: (intent) => <When at={intent.proposedAt} />,
  nowrap: true,
};

const recentColumns: readonly Column<IntentView>[] = [
  { key: "id", header: "Intent", cell: (intent) => <IntentLink id={intent.id} />, nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName symbol={intent.market} />,
    role: "primary",
  },
  { key: "amount", header: "Amount", cell: (intent) => amountLabel(intent), align: "end", nowrap: true },
  { key: "verdict", header: "Verdict", cell: (intent) => <IntentVerdict intent={intent} /> },
  timeColumn,
];

const orderColumn: Column<IntentView> = {
  key: "order",
  header: "Order",
  cell: (intent) => <OrderSummary intent={intent} />,
  nowrap: true,
};

function summary(snapshot: ConsoleSnapshot, waiting: number): string {
  const name = agentName(snapshot);
  if (!snapshot.chain?.rules) return `${name} can't trade yet: no rules are set.`;
  if (snapshot.chain.paused) return `${name} is paused. Every new intent is rejected until you resume it.`;
  if (waiting === 0) return `${name} is trading within your rules. Nothing needs you.`;
  return `${name} is trading within your rules. ${waiting.toString()} ${waiting === 1 ? "thing needs" : "things need"} you.`;
}

/** The owner's first screen: what needs them now, the rules in force, and the latest verdicts. */
export function HomeView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { advanced } = useAdvanced();
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Home" />;

  const attention = needsOwner(snapshot);
  const recent = newestFirst(chain).slice(0, 5);
  const rules = chain.rules;
  const usage = todayUsage(chain);
  const agent = snapshot.contract?.roles?.agent;
  const threshold = rules?.approvalAboveCents ?? 0;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Home"
        description={summary(snapshot, attention.total)}
        meta={
          advanced ? (
            <>
              {agent ? <HexValue label="Agent" value={agent} kind="address" /> : null}
              {chain.policySetBy ? (
                <span>
                  Rules v{chain.policyVersion.toString()}, set{" "}
                  {formatDateUtc(isoFromUnix(chain.policySetBy.timestamp))} at{" "}
                  {formatTimeUtc(isoFromUnix(chain.policySetBy.timestamp))}
                </span>
              ) : null}
            </>
          ) : undefined
        }
      />

      <section className={styles.section} aria-labelledby="needs-you">
        <div className={styles.sectionHead}>
          <h2 id="needs-you" className={styles.sectionTitle}>
            Needs you
          </h2>
          {attention.total > 0 ? <ArrowLink href="/approvals">All approvals</ArrowLink> : null}
        </div>
        {attention.total === 0 ? (
          <EmptyState title="You're all caught up" className={styles.caughtUp}>
            {threshold > 0
              ? `Intents above ${formatUsdCents(threshold)} wait here for your signature.`
              : "Intents above the approval threshold wait here for your signature."}
          </EmptyState>
        ) : (
          <NeedsYou snapshot={snapshot} attention={attention} />
        )}
      </section>

      <div className={styles.board} data-advanced={advanced || undefined}>
        <Card
          className={styles.rules}
          title="Rules in force"
          actions={<ArrowLink href="/rules">Rules</ArrowLink>}
        >
          {rules ? (
            advanced ? (
              <RulesSchedule
                rules={rules}
                committedCents={chain.committedCents}
                lossTodayCents={chain.lossTodayCents}
                usage={usage}
              />
            ) : (
              <>
                <RulesSummary
                  rules={rules}
                  committedCents={chain.committedCents}
                  lossTodayCents={chain.lossTodayCents}
                  usage={usage}
                />
                <AdvancedSection id="rule-meters">
                  <RulesSchedule
                    rules={rules}
                    committedCents={chain.committedCents}
                    lossTodayCents={chain.lossTodayCents}
                    usage={usage}
                  />
                </AdvancedSection>
              </>
            )
          ) : (
            <NoPolicyYet />
          )}
        </Card>

        <Card
          className={styles.recent}
          title="Recent activity"
          padding="flush"
          actions={<ArrowLink href="/activity">All activity</ArrowLink>}
        >
          <Table
            caption="The five most recent intents and their verdicts"
            captionHidden
            columns={
              advanced
                ? [...recentColumns.slice(0, 3), orderColumn, ...recentColumns.slice(3)]
                : recentColumns
            }
            rows={recent}
            rowKey={(intent) => intent.id.toString()}
            empty={
              <EmptyState plain title="No intents yet">
                Each intent appears here as soon as the contract decides it.
              </EmptyState>
            }
          />
        </Card>
      </div>
    </div>
  );
}
