"use client";

import { describeReason } from "@mandate/shared";
import { ScrollText } from "lucide-react";

import { IntentLink } from "@/components/domain/Intent";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { formatCount, formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";

import { type AuditRow, EVENT_LABELS, auditRows } from "./audit-rows";
import styles from "./audit.module.css";
import { ExportCsvButton } from "./ExportCsvButton";

const columns: readonly Column<AuditRow>[] = [
  {
    key: "when",
    header: "Time",
    cell: (row) => (
      <span className={styles.when}>
        <span>{formatTimeUtc(row.at)}</span>
        <span className={styles.date}>{formatDateUtc(row.at)}</span>
      </span>
    ),
    nowrap: true,
  },
  {
    key: "block",
    header: "Block",
    cell: (row) => formatCount(row.blockNumber),
    align: "end",
    nowrap: true,
  },
  {
    key: "event",
    header: "Event",
    cell: (row) => (
      <span className={styles.event}>
        <span className={styles.eventName}>
          {EVENT_LABELS[row.event]}
          {row.intentId === null ? null : (
            <>
              {" "}
              <IntentLink id={row.intentId} />
            </>
          )}
        </span>
        <span>{row.summary}</span>
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
  },
];

/** Every decision the Policy contract made, read from its events, with the rejections by rule. */
export function AuditView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const chain = snapshot.chain;
  if (!chain || !snapshot.contract) return <ChainUnavailable snapshot={snapshot} title="Audit" />;
  const rows = auditRows(chain);
  const blocked = Object.entries(chain.rejectionsByReason)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = blocked.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className={styles.view}>
      <PageHeader
        title="Audit"
        description="Every decision the Policy contract made, straight from its events. Each row links to its transaction."
        meta={<HexValue label="Policy contract" value={snapshot.contract.address} kind="address" />}
        actions={<ExportCsvButton rows={rows} />}
      />

      <div className={styles.layout}>
        <Card title="Events" padding="flush" headingLevel={2} className={styles.events}>
          <Table
            caption="Policy contract events, newest first"
            captionHidden
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            rowTone={(row) => (row.status === "rejected" ? "muted" : undefined)}
            empty={
              <EmptyState plain icon={<ScrollText strokeWidth={1.75} />} title="No events yet">
                The first event appears when you set a mandate. Every intent after that adds a row.
              </EmptyState>
            }
          />
        </Card>

        <Card
          title="Blocked attempts"
          description="Intents the contract rejected, by the rule that stopped them."
          headingLevel={2}
          className={styles.blocked}
        >
          {blocked.length === 0 ? (
            <p className={styles.none}>Nothing blocked. Every intent so far was inside the mandate.</p>
          ) : (
            <dl className={styles.rules}>
              {blocked.map(([reason, count]) => (
                <div key={reason} className={styles.rule}>
                  <dt>
                    <span className={styles.ruleLabel}>{describeReason(reason).label}</span>
                    <span className={`mono ${styles.ruleCode}`}>{reason}</span>
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
        </Card>
      </div>
    </div>
  );
}
