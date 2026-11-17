"use client";

import { describeReason } from "@mandate/shared";
import { ScrollText } from "lucide-react";
import { useState } from "react";

import { FlaggedBadge, IntentLink } from "@/components/domain/Intent";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Advanced, useAdvanced, useAdvancedColumns } from "@/lib/advanced/Advanced";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { type TabItem, Tabs } from "@/components/ui/Tabs";
import { When } from "@/components/ui/When";
import { formatCount } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";

import {
  type AuditGroup,
  type AuditOrder,
  type AuditRow,
  GROUP_LABELS,
  auditRows,
  blockedByRule,
  onScreen,
  toCsv,
  toJson,
  visibleRows,
} from "./audit-rows";
import styles from "./audit.module.css";
import { ExportButtons } from "./ExportButtons";
import { OwnerActions } from "./OwnerActions";

const columns: readonly Column<AuditRow>[] = [
  {
    key: "when",
    header: "Time",
    cell: (row) => <When at={row.at} className={styles.when} dateClassName={styles.date} />,
    nowrap: true,
  },
  {
    key: "block",
    header: "Block",
    cell: (row) => formatCount(row.blockNumber),
    align: "end",
    nowrap: true,
    advanced: true,
  },
  {
    key: "event",
    header: "Event",
    cell: (row) => (
      <span className={styles.event}>
        <span className={styles.eventName}>
          {row.label}
          {row.intentId === null ? null : (
            <>
              {" "}
              <IntentLink id={row.intentId} />
            </>
          )}
        </span>
        <span className={styles.summary}>{row.summary}</span>
        {row.flags.length > 0 ? (
          <span className={styles.flagged}>
            <FlaggedBadge flags={row.flags} />
          </span>
        ) : null}
        <Advanced>
          <span className={`mono ${styles.eventCode}`}>{row.event}</span>
        </Advanced>
      </span>
    ),
    role: "primary",
  },
  {
    key: "result",
    header: "Result",
    cell: (row) =>
      row.status ? (
        <StatusChip status={row.status} reason={row.reason} />
      ) : (
        <span className={styles.none}>None</span>
      ),
  },
  {
    key: "tx",
    header: "Transaction",
    cell: (row) => <HexValue value={row.txHash} kind="tx" />,
    nowrap: true,
    advanced: true,
  },
];

const ORDER_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
] as const satisfies readonly { value: AuditOrder; label: string }[];

const GROUPS: readonly (AuditGroup | "all")[] = [
  "all",
  "mandate",
  "pause",
  "roles",
  "verdict",
  "owner",
  "result",
];

const emptyText: Record<AuditGroup | "all", string> = {
  all: "The first event appears when you set the rules. Every intent after that adds a row.",
  mandate: "No rules have been signed yet.",
  pause: "Trading has not been paused.",
  roles: "No role change is recorded. Contracts before v2 record none.",
  verdict: "No intent has been proposed yet.",
  owner: "You have not approved or rejected a held intent yet.",
  result: "The executor has not recorded a result yet.",
};

/**
 * Every decision the Policy contract recorded, read from the events the console ingested: mandate
 * changes, the kill switch, verdicts, the owner's approvals and rejections, and executor results. Each
 * row carries its block, time and transaction, and the exports hold exactly the rows on screen.
 */
export function AuditView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const [group, setGroup] = useState<AuditGroup | "all">("all");
  const [order, setOrder] = useState<AuditOrder>("newest");
  const { advanced } = useAdvanced();
  const shownColumns = useAdvancedColumns(columns);
  const chain = snapshot.chain;
  const contract = snapshot.contract;
  if (!chain || !contract) return <ChainUnavailable snapshot={snapshot} title="Audit" />;

  const all = auditRows(chain);
  const rows = onScreen(all);
  const shown = visibleRows(rows, group, order);
  // The exports keep the raw events the table leaves out (see `AuditRow.unchanged`).
  const exported = visibleRows(all, group, order);
  const leftOut = exported.length - shown.length;
  const blocked = blockedByRule(rows).filter(([reason]) => reason !== "rejected by user");
  const total = blocked.reduce((sum, [, count]) => sum + count, 0);
  const ownerRejected = rows.filter((row) => row.reason === "rejected by user").length;
  const explorer = snapshot.network.explorerUrl;
  const orderWord = order === "newest" ? "newest first" : "oldest first";

  const tabs: TabItem[] = GROUPS.map((id) => {
    const count = id === "all" ? rows.length : rows.filter((row) => row.group === id).length;
    const label = id === "all" ? "All" : GROUP_LABELS[id];
    return {
      id,
      label,
      count,
      content:
        id === group ? (
          <Table
            caption={`${label}: Policy contract events, ${orderWord}`}
            captionHidden
            columns={shownColumns}
            rows={shown}
            rowKey={(row) => row.id}
            rowTone={(row) => (row.status === "rejected" ? "muted" : undefined)}
            empty={
              <EmptyState plain icon={<ScrollText strokeWidth={1.75} />} title="No events here yet">
                {emptyText[id]}
              </EmptyState>
            }
          />
        ) : null,
    };
  });

  return (
    <div className={styles.view}>
      <PageHeader
        title="Audit"
        description={
          advanced
            ? "Every decision the Policy contract recorded, read from its events. Each row carries its block and transaction, so it can be checked onchain."
            : "Every decision the Policy contract recorded. Advanced view adds each one's block and transaction, to check it onchain."
        }
        meta={
          advanced ? <HexValue label="Policy contract" value={contract.address} kind="address" /> : undefined
        }
        actions={
          <ExportButtons
            count={exported.length}
            baseName={`mandate-audit-${group}-${order}`}
            csv={() => toCsv(exported, explorer)}
            json={() =>
              toJson(exported, explorer, {
                contract: contract.address,
                chainId: snapshot.network.chainId,
                network: snapshot.network.name,
                filter: group,
                order,
                exportedAt: new Date().toISOString(),
              })
            }
          />
        }
      />

      <div className={styles.layout}>
        <Card
          title="Events"
          description={`${formatCount(shown.length)} of ${formatCount(rows.length)} shown, ${orderWord}.${
            leftOut > 0
              ? ` The exports also hold ${formatCount(leftOut)} pause ${leftOut === 1 ? "event" : "events"} that changed nothing: setPolicy emits one with every rule change.`
              : ""
          }`}
          padding="flush"
          headingLevel={2}
          className={styles.events}
          actions={
            <Select
              className={styles.order}
              value={order}
              onChange={setOrder}
              options={ORDER_OPTIONS}
              aria-label="Order of events"
            />
          }
        >
          <Tabs
            label="Filter events by kind"
            tabs={tabs}
            selected={group}
            onSelect={(id) => setGroup(GROUPS.find((candidate) => candidate === id) ?? "all")}
            inset
          />
        </Card>

        <Card
          title="Blocked attempts"
          description="Intents the contract rejected, by the rule that stopped them."
          headingLevel={2}
          className={styles.blocked}
        >
          {blocked.length === 0 ? (
            <p className={styles.none}>Nothing blocked. Every intent so far was inside the rules.</p>
          ) : (
            <dl className={styles.rules} data-testid="blocked-by-rule">
              {blocked.map(([reason, count]) => (
                <div key={reason} className={styles.rule}>
                  <dt>
                    <span className={styles.ruleLabel}>{describeReason(reason).label}</span>
                    <Advanced>
                      <span className={`mono ${styles.ruleCode}`}>{reason}</span>
                    </Advanced>
                  </dt>
                  <dd className="num">{formatCount(count)}</dd>
                </div>
              ))}
              <div className={styles.ruleTotal}>
                <dt>Total</dt>
                <dd className="num">{formatCount(total)}</dd>
              </div>
            </dl>
          )}
          {ownerRejected > 0 ? (
            <p className={styles.ownerNote}>
              You rejected {formatCount(ownerRejected)} held {ownerRejected === 1 ? "intent" : "intents"}{" "}
              yourself; those are not counted as blocked.
            </p>
          ) : null}
        </Card>
      </div>

      <OwnerActions />
    </div>
  );
}
