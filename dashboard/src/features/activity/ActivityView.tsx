"use client";

import { INTENT_STATUS_LABELS, type IntentStatus, type IntentView } from "@mandate/shared";
import { Inbox } from "lucide-react";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { IntentLink, IntentVerdict, MarketName, OrderAmount } from "@/components/domain/Intent";
import { SimulatedFill } from "@/components/domain/SimulatedFill";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { type TabItem, Tabs } from "@/components/ui/Tabs";
import { When } from "@/components/ui/When";
import { formatCount, formatUsdCents } from "@/lib/format";
import { useAdvancedColumns } from "@/lib/advanced/Advanced";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { agentName, countByStatus, newestFirst, todayUsage } from "@/lib/live/derive";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { fillsAreSimulated } from "@/lib/network";

import styles from "./activity.module.css";

const columns: readonly Column<IntentView>[] = [
  { key: "id", header: "Intent", cell: (intent) => <IntentLink id={intent.id} />, nowrap: true },
  {
    key: "time",
    header: "Time",
    cell: (intent) => <When at={intent.proposedAt} />,
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: (intent) => (
      <MarketName symbol={intent.market} category={intent.category} listing={intent.listing} />
    ),
    role: "primary",
  },
  {
    key: "order",
    header: "Order",
    // Not nowrap: an order the MCP server could not have sent reads longer, and wraps rather than widening.
    cell: (intent) => <OrderAmount intent={intent} />,
    align: "end",
  },
  {
    key: "verdict",
    header: "Verdict",
    cell: (intent) => <IntentVerdict intent={intent} />,
  },
  {
    key: "tx",
    header: "Proposal",
    cell: (intent) => <HexValue value={intent.proposedTxHash} kind="tx" />,
    nowrap: true,
    advanced: true,
  },
  {
    key: "actions",
    header: "Decision",
    cell: (intent) => (intent.status === "needs_approval" ? <ApprovalActions intent={intent} /> : null),
    role: "actions",
    nowrap: true,
  },
];

interface Filter {
  id: string;
  label: string;
  statuses: readonly IntentStatus[];
  empty: string;
}

const filters: readonly Filter[] = [
  {
    id: "all",
    label: "All",
    statuses: ["none", "approved", "needs_approval", "rejected", "executed", "failed"],
    empty: "No intents yet",
  },
  {
    id: "waiting",
    label: "Waiting",
    statuses: ["needs_approval"],
    empty: "Nothing needs your approval",
  },
  {
    id: "approved",
    label: INTENT_STATUS_LABELS.approved,
    statuses: ["approved"],
    empty: "Nothing waiting to fill",
  },
  {
    id: "executed",
    label: INTENT_STATUS_LABELS.executed,
    statuses: ["executed"],
    empty: "Nothing filled yet",
  },
  { id: "failed", label: INTENT_STATUS_LABELS.failed, statuses: ["failed"], empty: "No failed orders" },
  { id: "rejected", label: INTENT_STATUS_LABELS.rejected, statuses: ["rejected"], empty: "No rejections" },
];

/** Every intent, live, with the contract's verdict, filters by status, and approve or reject for the waiting ones. */
export function ActivityView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const shown = useAdvancedColumns(columns);
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Activity" />;

  const intents = newestFirst(chain);
  const usage = todayUsage(chain);
  const waiting = countByStatus(intents, ["needs_approval"]);
  const filledCents = intents.reduce(
    (sum, intent) => sum + (intent.status === "executed" ? (intent.filledCents ?? 0) : 0),
    0,
  );
  const executed = countByStatus(intents, ["executed"]);

  const tabs: TabItem[] = filters.map((filter) => {
    const rows = intents.filter((intent) => filter.statuses.includes(intent.status));
    return {
      id: filter.id,
      label: filter.label,
      count: rows.length,
      content: (
        <Table
          caption={`${filter.label} intents`}
          captionHidden
          columns={shown}
          rows={rows}
          rowKey={(intent) => intent.id.toString()}
          rowTone={(intent) => (intent.status === "needs_approval" ? "attention" : undefined)}
          empty={
            <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title={filter.empty}>
              {filter.id === "all"
                ? "Intents appear here the moment the Policy contract decides them, without a refresh."
                : "Intents in this state appear here as they land onchain."}
            </EmptyState>
          }
        />
      ),
    };
  });

  return (
    <div className={styles.view}>
      <PageHeader
        title="Activity"
        description={`Every intent ${agentName(snapshot, true)} sent, what the Policy contract decided, and what still needs your signature.`}
      />

      <StatGroup className={styles.stats}>
        <Stat
          label="Intents today"
          value={formatCount(usage.intents)}
          hint={`${formatCount(intents.length)} in all`}
        />
        <Stat
          label="Blocked today"
          value={formatCount(usage.blocked)}
          hint={`${formatCount(countByStatus(intents, ["rejected"]))} rejected in all`}
        />
        <Stat
          label="Filled"
          value={formatUsdCents(filledCents)}
          hint={
            <>
              {`${formatCount(executed)} ${executed === 1 ? "fill" : "fills"} recorded`}
              {fillsAreSimulated(snapshot.network) && executed > 0 ? (
                <SimulatedFill className={styles.statMarker} />
              ) : null}
            </>
          }
        />
      </StatGroup>

      <Card padding="flush">
        <Tabs
          label="Filter intents by status"
          tabs={tabs}
          defaultTab={waiting > 0 ? "waiting" : "all"}
          inset
        />
      </Card>
    </div>
  );
}
