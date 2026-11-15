import { Inbox } from "lucide-react";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { MarketName, OrderAmount } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { type TabItem, Tabs } from "@/components/ui/Tabs";
import type { Intent, IntentStatus } from "@/lib/domain";
import { formatCount, formatTimeUtc, formatUsdCents } from "@/lib/format";

import styles from "./activity.module.css";

export interface ActivityData {
  intents: readonly Intent[];
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
    key: "order",
    header: "Order",
    cell: (intent) => <OrderAmount intent={intent} />,
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
  {
    key: "actions",
    header: "Decision",
    cell: (intent) => (intent.status === "held" ? <ApprovalActions intent={intent} /> : null),
    role: "actions",
    nowrap: true,
  },
];

const filters: readonly { id: string; label: string; statuses: readonly IntentStatus[]; empty: string }[] = [
  {
    id: "all",
    label: "All",
    statuses: ["approved", "held", "rejected", "filled", "unfilled"],
    empty: "No intents yet",
  },
  { id: "held", label: "Held", statuses: ["held"], empty: "Nothing needs your approval" },
  {
    id: "approved",
    label: "Approved",
    statuses: ["approved", "filled", "unfilled"],
    empty: "No approved intents",
  },
  { id: "rejected", label: "Rejected", statuses: ["rejected"], empty: "No rejections" },
];

function count(intents: readonly Intent[], statuses: readonly IntentStatus[]) {
  return intents.filter((intent) => statuses.includes(intent.status)).length;
}

export function ActivityView({ intents }: ActivityData) {
  const held = count(intents, ["held"]);
  const spent = intents
    .filter((intent) => intent.status === "filled")
    .reduce((sum, intent) => sum + intent.notionalCents, 0);

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
          columns={columns}
          rows={rows}
          rowKey={(intent) => intent.id}
          rowTone={(intent) => (intent.status === "held" ? "attention" : undefined)}
          empty={
            <EmptyState plain icon={<Inbox strokeWidth={1.75} />} title={filter.empty}>
              {filter.id === "all"
                ? "Intents appear here the moment the Policy contract decides them."
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
        description="Every intent Grok Bot sent, what the Policy contract decided, and what still needs your signature."
      />

      <StatGroup className={styles.stats}>
        <Stat label="Intents today" value={formatCount(intents.length)} />
        <Stat label="Waiting for you" value={formatCount(held)} hint="Held above the approval threshold" />
        <Stat label="Rejected by policy" value={formatCount(count(intents, ["rejected"]))} />
        <Stat
          label="Filled on Gemini"
          value={formatUsdCents(spent)}
          hint={`${formatCount(count(intents, ["filled"]))} orders`}
        />
      </StatGroup>

      <Card padding="flush">
        <Tabs label="Filter intents" tabs={tabs} defaultTab={held > 0 ? "held" : "all"} inset />
      </Card>
    </div>
  );
}
