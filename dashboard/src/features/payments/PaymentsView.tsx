"use client";

import type { IntentView } from "@mandate/shared";
import { Receipt } from "lucide-react";
import { useEffect, useState } from "react";

import { IntentLink } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { UsdcMeter } from "@/components/ui/LimitMeter";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { budgetReading, intentsByReceipt, paymentAnchor } from "@/lib/payments/links";
import type { SignalBudgetView, SignalPaymentView } from "@/lib/payments/types";
import { formatUsdc } from "@/lib/payments/usdc";

import styles from "./payments.module.css";

const at = (iso: string) => `${formatDateUtc(iso)}, ${formatTimeUtc(iso)}`;

interface PaymentRow {
  payment: SignalPaymentView;
  intents: IntentView[];
}

/** What a payment bought, in words: "BTC weekly signal, BTC2611202200", or the resource when no signal came back. */
function Bought({ payment }: { payment: SignalPaymentView }) {
  const { signal } = payment;
  if (!signal) {
    return (
      <span className={styles.item}>
        <span>No valid signal returned</span>
        <span className={styles.detail}>
          Paid for <code>{payment.resource}</code>
        </span>
      </span>
    );
  }
  const { cheap, fair, expensive, noOffer } = signal.counts;
  return (
    <span className={styles.item}>
      <span>
        {signal.asset} {signal.horizon} hedge signal, {signal.eventTicker}
      </span>
      <span className={styles.detail}>
        {cheap} cheap, {fair} fair, {expensive} expensive
        {noOffer > 0 ? `, ${noOffer.toString()} with no offer` : ""}. Computed {formatTimeUtc(signal.asOf)}.
      </span>
    </span>
  );
}

const columns: readonly Column<PaymentRow>[] = [
  {
    key: "time",
    header: "Paid",
    cell: ({ payment }) => (
      <time dateTime={payment.paidAt} className={styles.time}>
        <span>{formatTimeUtc(payment.paidAt)}</span>
        <span className={styles.detail}>{formatDateUtc(payment.paidAt)}</span>
      </time>
    ),
    nowrap: true,
  },
  { key: "item", header: "Bought", cell: ({ payment }) => <Bought payment={payment} />, role: "primary" },
  {
    key: "price",
    header: "Price",
    cell: ({ payment }) => <span className="num">{formatUsdc(payment.amount)}</span>,
    align: "end",
    nowrap: true,
  },
  {
    key: "used",
    header: "Used by",
    cell: ({ intents }) =>
      intents.length === 0 ? (
        <span className={styles.detail}>No intent cites it</span>
      ) : (
        <span className={styles.intents}>
          {intents.map((intent) => (
            <IntentLink key={intent.id} id={intent.id} />
          ))}
        </span>
      ),
  },
  {
    key: "receipt",
    header: "Receipt and settlement",
    cell: ({ payment }) => (
      <span className={styles.item}>
        <HexValue label="Receipt" value={payment.receiptId} kind="hash" />
        <span className={styles.detail}>
          {payment.settlementId ? (
            <>
              Gateway settlement <code className={styles.reference}>{payment.settlementId}</code>
            </>
          ) : (
            "No settlement reference given"
          )}
        </span>
      </span>
    ),
  },
  {
    key: "parties",
    header: "Payer and payee",
    cell: ({ payment }) => (
      <span className={styles.item}>
        <HexValue label="From" value={payment.payer} kind="address" />
        {payment.payee ? (
          <HexValue label="To" value={payment.payee} kind="address" />
        ) : (
          <span className={styles.detail}>Payee unknown</span>
        )}
      </span>
    ),
  },
];

/**
 * True once `deadline` has passed: a timer flips it at the deadline (or at once when it is already
 * past), so the budget drops to 0 on time without waiting for a new snapshot.
 */
function usePassed(deadline: string | null): boolean {
  const [passed, setPassed] = useState<string | null>(null);
  useEffect(() => {
    if (!deadline) return undefined;
    const wait = Math.max(0, Date.parse(deadline) - Date.now());
    if (wait > 2 ** 31 - 1) return undefined;
    const timer = setTimeout(() => setPassed(deadline), wait);
    return () => clearTimeout(timer);
  }, [deadline]);
  return deadline !== null && passed === deadline;
}

function BudgetCards({ budget, payments }: { budget: SignalBudgetView | null; payments: number }) {
  const reset = usePassed(budget?.resetsAt ?? null);
  if (!budget) {
    return (
      <Card title="Signal budget" headingLevel={2}>
        <EmptyState plain title="Not reported yet">
          The agent&apos;s MCP server reports its signal budget and Gateway balance when it starts and after
          every purchase. Nothing has arrived yet.
        </EmptyState>
      </Card>
    );
  }
  const reading = budgetReading(budget, reset);
  return (
    <div className={styles.top}>
      <Card title="Signal budget today" headingLevel={2}>
        <UsdcMeter label="Spent" used={reading.spent} limit={reading.daily} usedWord="of today's budget" />
        <p className={styles.note} data-testid="budget-note">
          {reading.reset
            ? `A new day started at ${at(budget.resetsAt)}; nothing is counted until the agent reports today's spend.`
            : `Resets ${at(budget.resetsAt)}. At most ${formatUsdc(reading.maxPerPurchase)} per purchase.`}
        </p>
      </Card>
      <Card title="Gateway balance" headingLevel={2}>
        <StatGroup>
          <Stat
            label="Available"
            value={
              budget.gatewayBalance === null ? (
                "Unknown"
              ) : (
                <span className="num">{formatUsdc(budget.gatewayBalance)}</span>
              )
            }
            hint={budget.gatewayBalance === null ? "The agent could not read it" : `As of ${at(budget.asOf)}`}
          />
          <Stat
            label="Purchases recorded"
            value={<span className="num">{payments.toString()}</span>}
            hint="All time"
          />
        </StatGroup>
        <p className={styles.note}>
          <HexValue label="Buyer wallet" value={budget.buyerAddress} kind="address" />
        </p>
      </Card>
    </div>
  );
}

/** The agent's x402 payments for signals, its daily signal budget and its Gateway balance, as it reported them. */
export function PaymentsView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { signalPayments, signalBudget, pairing } = snapshot.offchain;
  const agentName = pairing?.agentName ?? "The agent";
  const byReceipt = intentsByReceipt(snapshot.chain);
  const rows: PaymentRow[] = signalPayments.map((payment) => ({
    payment,
    intents: byReceipt.get(payment.receiptId) ?? [],
  }));

  return (
    <div className={styles.view}>
      <PageHeader
        title="Payments"
        description={`What ${agentName} paid for signals over x402, in USDC from its Circle Gateway balance. This spend is separate from the trading budget.`}
      />
      <BudgetCards budget={signalBudget} payments={signalPayments.length} />
      <Card
        title="Purchases"
        description="Newest first, as the agent's MCP server reported them."
        padding="flush"
        headingLevel={2}
      >
        <Table
          caption="Paid signal requests, newest first"
          captionHidden
          columns={columns}
          rows={rows}
          rowKey={({ payment }) => payment.receiptId}
          rowId={({ payment }) => paymentAnchor(payment.receiptId)}
          empty={
            <EmptyState plain icon={<Receipt strokeWidth={1.75} />} title="No purchases yet">
              When the agent pays for a signal, the purchase, its receipt and its settlement reference appear
              here without a refresh.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
