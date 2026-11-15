import { ScrollText } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { type AuditRecord, type ReasonCode, reasonLabels } from "@/lib/domain";
import { formatCount, formatDateUtc, formatTimeUtc } from "@/lib/format";

import { ExportCsvButton } from "./ExportCsvButton";
import styles from "./audit.module.css";

export interface AuditData {
  records: readonly AuditRecord[];
  policyAddress: string;
}

const eventLabels: Record<AuditRecord["event"], string> = {
  IntentSubmitted: "Intent submitted",
  IntentApproved: "Intent approved",
  IntentHeld: "Intent held",
  IntentRejected: "Intent rejected",
  IntentFilled: "Intent filled",
  PolicySet: "Mandate set",
  Paused: "Agent paused",
};

const columns: readonly Column<AuditRecord>[] = [
  {
    key: "when",
    header: "Time",
    cell: (record) => (
      <span className={styles.when}>
        <span>{formatTimeUtc(record.at)}</span>
        <span className={styles.date}>{formatDateUtc(record.at)}</span>
      </span>
    ),
    nowrap: true,
  },
  {
    key: "block",
    header: "Block",
    cell: (record) => formatCount(record.blockNumber),
    align: "end",
    nowrap: true,
  },
  {
    key: "event",
    header: "Event",
    cell: (record) => (
      <span className={styles.event}>
        <span className={styles.eventName}>{eventLabels[record.event]}</span>
        <span>{record.summary}</span>
      </span>
    ),
    role: "primary",
  },
  {
    key: "result",
    header: "Result",
    cell: (record) =>
      record.status ? (
        <StatusChip status={record.status} reasonCode={record.reasonCode} />
      ) : (
        <span className={styles.none}>None</span>
      ),
  },
  {
    key: "tx",
    header: "Transaction",
    cell: (record) => <HexValue value={record.txHash} kind="tx" />,
    nowrap: true,
  },
];

function blockedByRule(records: readonly AuditRecord[]) {
  const counts = new Map<ReasonCode, number>();
  for (const record of records) {
    if (record.status === "rejected" && record.reasonCode) {
      counts.set(record.reasonCode, (counts.get(record.reasonCode) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function AuditView({ records, policyAddress }: AuditData) {
  const blocked = blockedByRule(records);
  const total = blocked.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className={styles.view}>
      <PageHeader
        title="Audit"
        description="Every decision the Policy contract made, straight from its events. Each row links to its transaction."
        meta={<HexValue label="Policy contract" value={policyAddress} kind="address" />}
        actions={<ExportCsvButton records={records} />}
      />

      <div className={styles.layout}>
        <Card title="Events" padding="flush" headingLevel={2} className={styles.events}>
          <Table
            caption="Policy contract events, newest first"
            captionHidden
            columns={columns}
            rows={records}
            rowKey={(record) => record.id}
            rowTone={(record) => (record.status === "rejected" ? "muted" : undefined)}
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
              {blocked.map(([code, count]) => (
                <div key={code} className={styles.rule}>
                  <dt>
                    <span className={styles.ruleLabel}>{reasonLabels[code]}</span>
                    <span className={`mono ${styles.ruleCode}`}>{code}</span>
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
