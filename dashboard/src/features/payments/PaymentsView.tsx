import { Receipt } from "lucide-react";

import { SampleDataNote } from "@/components/states/ChainStates";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { LimitMeter } from "@/components/ui/LimitMeter";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import type { SamplePayment } from "@/fixtures/samples";
import { formatCount, formatTimeUtc } from "@/lib/format";

import styles from "./payments.module.css";

type Payment = SamplePayment;

export interface PaymentsData {
  payments: readonly Payment[];
  summary: { spentTodayCents: number; toolBudgetCents: number; gatewayBalanceCents: number };
}

const columns: readonly Column<Payment>[] = [
  { key: "time", header: "Time", cell: (payment) => formatTimeUtc(payment.at), nowrap: true },
  {
    key: "item",
    header: "Bought",
    cell: (payment) => (
      <span className={styles.item}>
        <span>{payment.item}</span>
        <span className={styles.provider}>{payment.provider}</span>
      </span>
    ),
    role: "primary",
  },
  {
    key: "price",
    header: "Price",
    cell: (payment) => <Money cents={payment.priceCents} />,
    align: "end",
    nowrap: true,
  },
  {
    key: "tx",
    header: "Settlement",
    // Sample hashes are not real transactions, so they link nowhere.
    cell: (payment) => <HexValue value={payment.settlementTx} kind="hash" />,
    nowrap: true,
  },
];

/** x402 tool payments. Every number here is sample data until the payments service lands (#22). */
export function PaymentsView({ payments, summary }: PaymentsData) {
  return (
    <div className={styles.view}>
      <PageHeader
        title="Payments"
        description="What Grok Bot paid for data and signals over x402, settled in USDC on Arc. This spend is separate from the trading budget."
      />

      <SampleDataNote issue="#22" className={styles.sampleNote}>
        Illustrative purchases and balances, not read from the agent&apos;s wallet.
      </SampleDataNote>

      <div className={styles.top}>
        <Card title="Tool budget today" headingLevel={2}>
          <LimitMeter
            label="Spent"
            usedCents={summary.spentTodayCents}
            limitCents={summary.toolBudgetCents}
            usedWord="of today's budget"
          />
        </Card>
        <Card title="Payment balance" headingLevel={2}>
          <StatGroup>
            <Stat
              label="Available"
              value={<Money cents={summary.gatewayBalanceCents} />}
              hint="USDC the agent can spend"
            />
            <Stat label="Paid today" value={formatCount(payments.length)} hint="Purchases" />
          </StatGroup>
        </Card>
      </div>

      <Card title="Purchases" padding="flush" headingLevel={2}>
        <Table
          caption="Paid tool calls, newest first"
          captionHidden
          columns={columns}
          rows={payments}
          rowKey={(payment) => payment.id}
          empty={
            <EmptyState plain icon={<Receipt strokeWidth={1.75} />} title="No purchases yet">
              When the agent pays for a signal, the purchase and its settlement transaction appear here.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
