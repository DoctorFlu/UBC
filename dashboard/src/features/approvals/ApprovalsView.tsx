"use client";

import { IntentLink, IntentVerdict, MarketName, amountLabel } from "@/components/domain/Intent";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { When } from "@/components/ui/When";
import { useAdvanced } from "@/lib/advanced/Advanced";
import { formatUsdCents } from "@/lib/format";
import { type HeldDecision, decidedAfterHold, needsOwner } from "@/lib/live/attention";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { useQueryTab } from "@/lib/useQueryTab";

import type { ConsoleSnapshot } from "@/lib/live/types";

import styles from "./approvals.module.css";
import { NeedsYou } from "./NeedsYou";

export type ApprovalsTab = "waiting" | "decided";

function decidedAt({ decidedAt: at }: HeldDecision) {
  return at === null ? "Not recorded" : <When at={at} date />;
}

const baseColumns: readonly Column<HeldDecision>[] = [
  { key: "id", header: "Intent", cell: ({ intent }) => <IntentLink id={intent.id} />, nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: ({ intent }) => <MarketName symbol={intent.market} />,
    role: "primary",
  },
  { key: "amount", header: "Amount", cell: ({ intent }) => amountLabel(intent), align: "end", nowrap: true },
  { key: "verdict", header: "Outcome", cell: ({ intent }) => <IntentVerdict intent={intent} /> },
  { key: "when", header: "Decided", cell: decidedAt, nowrap: true },
];

const txColumn: Column<HeldDecision> = {
  key: "tx",
  header: "Decision",
  cell: ({ intent }) => (intent.decidedTxHash ? <HexValue value={intent.decidedTxHash} kind="tx" /> : "None"),
  nowrap: true,
};

/** What waits for the owner's signature, and the held intents already decided. */
export function ApprovalsView({ tab, preview }: { tab: ApprovalsTab; preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { advanced } = useAdvanced();
  const [shown, select] = useQueryTab<ApprovalsTab>("show", tab, "waiting");
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Approvals" />;

  const attention = needsOwner(snapshot);
  const decided = decidedAfterHold(chain);
  const threshold = chain.rules?.approvalAboveCents ?? 0;
  const columns = advanced ? [...baseColumns, txColumn] : baseColumns;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Approvals"
        description={
          threshold > 0
            ? `Intents above ${formatUsdCents(threshold)} wait here for your signature.`
            : "Intents above the approval threshold wait here for your signature."
        }
      />
      <Tabs
        label="Approvals"
        selected={shown}
        onSelect={(id) => select(id === "decided" ? "decided" : "waiting")}
        tabs={[
          {
            id: "waiting",
            label: "Waiting",
            count: attention.total,
            content:
              attention.total === 0 ? (
                <EmptyState title="Nothing waiting for you">
                  Held intents, rule change requests and pairings appear here.
                </EmptyState>
              ) : (
                <NeedsYou snapshot={snapshot} attention={attention} />
              ),
          },
          {
            id: "decided",
            label: "Decided",
            count: decided.length,
            content: (
              <Card padding="flush">
                <Table
                  caption="Held intents you decided"
                  captionHidden
                  columns={columns}
                  rows={decided}
                  rowKey={({ intent }) => intent.id.toString()}
                  empty={
                    <EmptyState plain title="Nothing decided yet">
                      Intents you approve or reject appear here.
                    </EmptyState>
                  }
                />
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
