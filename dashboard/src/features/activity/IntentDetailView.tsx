"use client";

import { type PolicyEvent, describeReason } from "@mandate/shared";
import { ArrowLeft, SearchX, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import Link from "next/link";
import type { Hex } from "viem";

import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { MarketName, OrderSummary } from "@/components/domain/Intent";
import { SimulatedFill } from "@/components/domain/SimulatedFill";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip, statusDescriptions } from "@/components/ui/StatusChip";
import { formatCount, formatDateUtc, formatTimeUtc, formatUsdCents } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { intentEvents, isoFromUnix } from "@/lib/live/derive";
import type { ChainView, ConsoleSnapshot, SealedReason } from "@/lib/live/types";
import { categoryName, describeMarket } from "@/lib/markets";
import { fillsAreSimulated } from "@/lib/network";

import styles from "./detail.module.css";

interface Step {
  key: string;
  title: string;
  detail: string | null;
  tone: "neutral" | "good" | "attention" | "bad";
  /** A fill recorded by the local devchain's simulated executor. */
  simulated?: boolean;
  timestamp: number;
  blockNumber: number;
  txHash: Hex;
}

function steps(chain: ChainView, intentId: number, simulated: boolean): Step[] {
  const events = intentEvents(chain, intentId);
  const intent = chain.intents.find((candidate) => candidate.id === intentId);
  const out: Step[] = [];
  const meta = (event: PolicyEvent) => ({
    key: `${event.transactionHash}:${event.logIndex.toString()}`,
    timestamp: event.blockTimestamp,
    blockNumber: event.blockNumber,
    txHash: event.transactionHash,
  });
  if (intent && !events.some((event) => event.type === "IntentProposed")) {
    // The production contract emits no proposal event: the verdict's transaction is the proposal.
    const first = events[0];
    if (first) {
      out.push({
        ...meta(first),
        key: `${first.transactionHash}:proposed`,
        title: "Proposed by the agent",
        detail: "This contract emits no proposal event; the verdict below came in the same transaction.",
        tone: "neutral",
      });
    }
  }
  let waited = false;
  for (const event of events) {
    switch (event.type) {
      case "IntentProposed":
        out.push({
          ...meta(event),
          title: "Proposed by the agent",
          detail: `From ${event.agent}.`,
          tone: "neutral",
        });
        break;
      case "IntentNeedsApproval":
        waited = true;
        out.push({
          ...meta(event),
          title: "Held for your approval",
          detail: "Above the approval threshold, so the contract waited for the owner.",
          tone: "attention",
        });
        break;
      case "IntentApproved":
        out.push({
          ...meta(event),
          title: waited ? "Approved by you" : "Approved by the contract",
          detail: waited
            ? "The contract re-checked the budget and approved it."
            : "Inside every rule of the mandate.",
          tone: "good",
        });
        break;
      case "IntentRejected": {
        const byOwner = event.reason === "rejected by user";
        out.push({
          ...meta(event),
          title: byOwner ? "Rejected by you" : `Rejected by the contract: ${event.reason}`,
          detail: describeReason(event.reason).explanation,
          tone: "bad",
        });
        break;
      }
      case "ResultRecorded":
        out.push({
          ...meta(event),
          // The contract only knows that the executor recorded a result, not where the order went.
          title: event.filled ? "Filled" : "Did not fill",
          detail: event.filled
            ? `The executor recorded a fill of ${formatUsdCents(event.filledCents)}.`
            : "The executor recorded that the order did not fill; its amount went back to the budget.",
          tone: event.filled ? "good" : "neutral",
          simulated: simulated && event.filled,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

const SOURCE_BADGES = { onchain: "Sealed onchain", offchain: "Recorded offchain" } as const;

const SOURCE_TEXT = {
  onchain: "the hash the contract recorded when the agent proposed the intent",
  offchain: "the hash the agent linked to this intent's proposal through the console",
} as const;

/**
 * The agent's reason, resolved by the console: the onchain `contextHash` when the contract records one,
 * otherwise the agent's offchain link, otherwise none. The document is checked with `verifyContext`.
 */
function SealedReasonCard({ sealed }: { sealed: SealedReason | undefined }) {
  if (!sealed) {
    return (
      <Card title="The agent's reason" headingLevel={2}>
        <div className={styles.sealed} data-sealed="none" data-testid="sealed-reason">
          <ShieldQuestion aria-hidden className={styles.sealedIcon} />
          <div>
            <p className={styles.sealedTitle}>No reason recorded</p>
            <p className={styles.sealedText}>
              No decision context hash was recorded onchain or linked by the agent, so there is no reason to
              check.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  const badge = <span className={styles.sourceBadge}>{SOURCE_BADGES[sealed.source]}</span>;
  if (sealed.status === "not_stored") {
    return (
      <Card title="The agent's reason" headingLevel={2} actions={badge}>
        <div className={styles.sealed} data-sealed="not_stored" data-testid="sealed-reason">
          <ShieldQuestion aria-hidden className={styles.sealedIcon} />
          <div className={styles.sealedBody}>
            <p className={styles.sealedTitle}>Not recorded</p>
            <p className={styles.sealedText}>
              There is a hash ({SOURCE_TEXT[sealed.source]}), but the agent never stored the document behind
              it, so its reason can&apos;t be shown or checked.
            </p>
            <HexValue label="Hash" value={sealed.hash} kind="hash" />
          </div>
        </div>
      </Card>
    );
  }
  if (sealed.status === "tampered") {
    return (
      <Card title="The agent's reason" headingLevel={2} tone="attention" actions={badge}>
        <div className={styles.sealed} data-sealed="tampered" data-testid="sealed-reason">
          <ShieldAlert aria-hidden className={styles.sealedIcon} />
          <div className={styles.sealedBody}>
            <p className={styles.sealedTitle}>Tampered</p>
            <p className={styles.sealedText}>
              The stored document does not match {SOURCE_TEXT[sealed.source]}. It was changed after the fact,
              so the console does not show it.
            </p>
            <HexValue label="Hash" value={sealed.hash} kind="hash" />
          </div>
        </div>
      </Card>
    );
  }
  const doc = sealed.document;
  return (
    <Card title="The agent's reason" headingLevel={2} actions={badge}>
      <div className={styles.sealed} data-sealed="verified" data-testid="sealed-reason">
        <ShieldCheck aria-hidden className={styles.sealedIcon} />
        <div className={styles.sealedBody}>
          <p className={styles.sealedTitle}>Verified</p>
          <p className={styles.sealedText}>This document hashes to exactly {SOURCE_TEXT[sealed.source]}.</p>
          <blockquote className={styles.reason}>
            <p>{doc.reason}</p>
          </blockquote>
          <dl className={styles.facts}>
            <dt>Your request</dt>
            <dd>{doc.requestText}</dd>
            <dt>Plan</dt>
            <dd className="mono">
              {doc.planId}, rung {(doc.rungIndex + 1).toString()}
            </dd>
            <dt>Prices seen</dt>
            <dd>
              {doc.ladderSummary.rungs
                .map(
                  (rung) =>
                    `${rung.label}: YES ${rung.yesBidCents?.toString() ?? "-"}/${rung.yesAskCents?.toString() ?? "-"}¢`,
                )
                .join("; ")}{" "}
              at {formatTimeUtc(doc.ladderSummary.observedAt)}
            </dd>
            <dt>Paid signals</dt>
            <dd>{doc.signalReceiptIds.length === 0 ? "None" : doc.signalReceiptIds.join(", ")}</dd>
            <dt>Hash</dt>
            <dd>
              <HexValue value={sealed.hash} kind="hash" />
            </dd>
          </dl>
        </div>
      </div>
    </Card>
  );
}

/** One intent with every onchain step, its links, and the agent's sealed reason checked against the chain. */
export function IntentDetailView({ intentId, preview }: { intentId: number; preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const chain = snapshot.chain;
  const title = `Intent #${intentId.toString()}`;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title={title} />;
  const intent = chain.intents.find((candidate) => candidate.id === intentId);
  if (!intent) {
    return (
      <div className={styles.view}>
        <PageHeader title={title} />
        <EmptyState
          icon={<SearchX strokeWidth={1.75} />}
          title="No such intent yet"
          action={<ArrowLink href="/activity">All activity</ArrowLink>}
        >
          The contract has {formatCount(chain.intents.length)}{" "}
          {chain.intents.length === 1 ? "intent" : "intents"}, and ids start at 0. If the agent is proposing
          this one right now, it appears here as soon as it lands.
        </EmptyState>
      </div>
    );
  }
  const market = intent.market ? describeMarket(intent.market) : null;
  const simulated = fillsAreSimulated(snapshot.network);
  const timeline = steps(chain, intent.id, simulated);

  return (
    <div className={styles.view}>
      <Link href="/activity" className={styles.back}>
        <ArrowLeft aria-hidden className={styles.backIcon} strokeWidth={2} />
        Activity
      </Link>
      <PageHeader
        title={title}
        description={`${market?.title ?? "Unknown market"}. ${statusDescriptions[intent.status]}`}
        meta={
          <>
            <StatusChip status={intent.status} reason={intent.reason} />
            <span>
              Proposed {formatDateUtc(isoFromUnix(intent.proposedAt))},{" "}
              {formatTimeUtc(isoFromUnix(intent.proposedAt))}
            </span>
          </>
        }
      />

      <div className={styles.layout}>
        <div className={styles.main}>
          <Card title="Order" headingLevel={2}>
            <dl className={styles.facts}>
              <dt>Market</dt>
              <dd>
                <MarketName symbol={intent.market} />
              </dd>
              <dt>Category</dt>
              <dd>{categoryName(intent.category)}</dd>
              <dt>Order</dt>
              <dd>
                <OrderSummary intent={intent} />
              </dd>
              <dt>Amount</dt>
              <dd>{intent.amountCents === null ? "Unknown" : <Money cents={intent.amountCents} />}</dd>
              {intent.filledCents !== null ? (
                <>
                  <dt>Filled</dt>
                  <dd className={styles.filled}>
                    <Money cents={intent.filledCents} />
                    {simulated && intent.status === "executed" ? <SimulatedFill /> : null}
                  </dd>
                  <dt>Realized P&amp;L</dt>
                  <dd>
                    <Money cents={intent.pnlCents ?? 0} sign="always" />
                  </dd>
                </>
              ) : null}
              {intent.agent ? (
                <>
                  <dt>Agent</dt>
                  <dd>
                    <HexValue value={intent.agent} kind="address" />
                  </dd>
                </>
              ) : null}
            </dl>
            {intent.status === "needs_approval" ? (
              <div className={styles.decide}>
                <ApprovalActions intent={intent} />
              </div>
            ) : null}
          </Card>

          <SealedReasonCard sealed={chain.sealed[intent.id]} />
        </div>

        <Card
          title="Onchain steps"
          description="Every Policy event for this intent, oldest first."
          headingLevel={2}
        >
          <ol className={styles.timeline} data-testid="intent-timeline">
            {timeline.map((step) => (
              <li key={step.key} className={styles.step} data-tone={step.tone}>
                <span className={styles.stepDot} aria-hidden />
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>
                    {step.title}
                    {step.simulated ? <SimulatedFill /> : null}
                  </p>
                  {step.detail ? <p className={styles.stepDetail}>{step.detail}</p> : null}
                  <p className={styles.stepMeta}>
                    <span>
                      {formatTimeUtc(isoFromUnix(step.timestamp))}, block {formatCount(step.blockNumber)}
                    </span>
                    <HexValue value={step.txHash} kind="tx" />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
