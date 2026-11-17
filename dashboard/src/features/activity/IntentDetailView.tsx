"use client";

import {
  type IntentView,
  type LadderSummary,
  type PolicyEvent,
  describeReason,
  isMarketSymbol,
} from "@mandate/shared";
import { ArrowLeft, SearchX, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import type { Hex } from "viem";

import { AgentReason } from "@/components/domain/AgentReason";
import { RequestText } from "@/components/domain/RequestText";
import { ApprovalActions } from "@/components/domain/ApprovalActions";
import { amountLabel, FlaggedBadge, intentFlags, MarketName, OrderSummary } from "@/components/domain/Intent";
import { SimulatedFill } from "@/components/domain/SimulatedFill";
import { ChainUnavailable } from "@/components/states/ChainStates";
import { Advanced } from "@/lib/advanced/Advanced";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { StatusChip, statusDescriptions } from "@/components/ui/StatusChip";
import { When } from "@/components/ui/When";
import {
  formatContractPrice,
  formatContractsHundredths,
  formatCount,
  formatUsdCents,
  shortenHex,
} from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { intentEvents } from "@/lib/live/derive";
import type {
  ChainView,
  ConsoleSnapshot,
  SealedReason,
  SettlementView,
  VenueOrderView,
} from "@/lib/live/types";
import { formatSettlementValue, totalsSentence } from "@/lib/settlement/settlement";
import { categoryName, describeMarket, namingCategory } from "@/lib/markets";
import { evidenceHref } from "@/lib/evidence/chain";
import { paymentHref } from "@/lib/payments/links";
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
  // The executor refuses what the MCP server could not have sent, and records it as not filled.
  const refused = intent !== undefined && intentFlags(intent).length > 0;
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
          detail: waited ? "The contract re-checked the budget and approved it." : "Inside every rule.",
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
            ? event.filledCents === null
              ? "The executor recorded a fill too large to show."
              : `The executor recorded a fill of ${formatUsdCents(event.filledCents)}.`
            : refused
              ? "The executor refuses intents like this one, flagged above, so it recorded that the order did not fill; its amount went back to the budget."
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

/** A YES price from the agent's document, which is untrusted: shown as-is when it is not a valid price. */
function yesPrice(cents: number | null): string {
  if (cents === null) return "-";
  return Number.isInteger(cents) && cents >= 0 && cents <= 100
    ? formatContractPrice(cents)
    : cents.toString();
}

/** The order book the agent saw, one row per strike, with the rung this intent trades marked. */
function PricesSeen({ ladder, market }: { ladder: LadderSummary; market: string | null }) {
  if (ladder.rungs.length === 0) return null;
  return (
    <div className={styles.prices} role="region" aria-labelledby="prices-seen" tabIndex={0}>
      <table className={styles.pricesTable} data-testid="prices-seen">
        <caption id="prices-seen" className={styles.pricesCaption}>
          Prices seen <When inSentence at={ladder.observedAt} date />
        </caption>
        <thead>
          <tr>
            <th scope="col">Strike</th>
            <th scope="col" className={styles.num}>
              YES bid
            </th>
            <th scope="col" className={styles.num}>
              YES ask
            </th>
          </tr>
        </thead>
        <tbody>
          {ladder.rungs.map((rung) => {
            const traded = rung.instrumentSymbol === market;
            return (
              <tr key={rung.instrumentSymbol} data-traded={traded || undefined}>
                <th scope="row">
                  {rung.label}
                  {traded ? <span className={styles.tradedTag}>This intent</span> : null}
                </th>
                <td className={styles.num}>{yesPrice(rung.yesBidCents)}</td>
                <td className={styles.num}>{yesPrice(rung.yesAskCents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
/** The receipt ids of the signals the agent paid for, each linked to its payment when the console has it. */
function PaidSignals({ receipts, payments }: { receipts: readonly string[]; payments: ReadonlySet<string> }) {
  if (receipts.length === 0) return <>None</>;
  return (
    <ul className={styles.receipts}>
      {receipts.map((receipt) => (
        <li key={receipt}>
          {payments.has(receipt.toLowerCase()) ? (
            <Link href={paymentHref(receipt)} className={styles.receipt}>
              {shortenHex(receipt, 10, 6)}
            </Link>
          ) : (
            <>
              <span className={styles.receipt}>{shortenHex(receipt, 10, 6)}</span>{" "}
              <span className={styles.receiptNote}>no payment recorded</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function SealedReasonCard({
  sealed,
  market,
  payments,
}: {
  sealed: SealedReason | undefined;
  market: string | null;
  payments: ReadonlySet<string>;
}) {
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
            <Advanced>
              <HexValue label="Hash" value={sealed.hash} kind="hash" />
            </Advanced>
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
            <Advanced>
              <HexValue label="Hash" value={sealed.hash} kind="hash" />
            </Advanced>
            {sealed.claims.planId ? (
              <ArrowLink href={evidenceHref(sealed.claims.planId)}>
                Evidence chain of the plan it claims
              </ArrowLink>
            ) : null}
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
          <AgentReason text={doc.reason} label="In the agent's own words" />
          <dl className={styles.facts}>
            <dt>Your request</dt>
            <dd>{doc.requestText ? <RequestText text={doc.requestText} /> : "None given"}</dd>
            <dt>Plan</dt>
            <dd className="mono">
              <Link href={evidenceHref(doc.planId)}>{doc.planId}</Link>, rung {(doc.rungIndex + 1).toString()}
            </dd>
            <dt>Paid signals</dt>
            <dd>
              <PaidSignals receipts={doc.signalReceiptIds} payments={payments} />
            </dd>
            <Advanced>
              <dt>Hash</dt>
              <dd>
                <HexValue value={sealed.hash} kind="hash" />
              </dd>
            </Advanced>
          </dl>
          <PricesSeen ladder={doc.ladderSummary} market={market} />
        </div>
      </div>
    </Card>
  );
}

/**
 * What the position paid when its market resolved. The Policy contract cannot record a payout, so the
 * executor signs it and the console stores it; the console checks the document against its hash here and
 * checked the signature against the contract's executor when it was stored.
 */
function SettlementCard({ settlement }: { settlement: SettlementView }) {
  const badge = <span className={styles.sourceBadge}>Signed by the executor</span>;
  if (settlement.status === "tampered") {
    return (
      <Card title="At expiry" headingLevel={2} tone="attention" actions={badge}>
        <div className={styles.sealed} data-sealed="tampered" data-testid="intent-settlement">
          <ShieldAlert aria-hidden className={styles.sealedIcon} />
          <div className={styles.sealedBody}>
            <p className={styles.sealedTitle}>Tampered</p>
            <p className={styles.sealedText}>
              The stored settlement no longer matches the hash it was stored under. It was changed after the
              fact, so the console does not show or count it.
            </p>
            <Advanced>
              <HexValue label="Hash" value={settlement.hash} kind="hash" />
            </Advanced>
          </div>
        </div>
      </Card>
    );
  }
  const doc = settlement.document;
  const level = formatSettlementValue(doc.settlementValue);
  const strike = doc.strikeCents === null ? null : formatUsdCents(doc.strikeCents);
  return (
    <Card title="At expiry" headingLevel={2} actions={badge}>
      <div className={styles.sealed} data-sealed="verified" data-testid="intent-settlement">
        <ShieldCheck aria-hidden className={styles.sealedIcon} />
        <div className={styles.sealedBody}>
          <p className={styles.sealedTitle}>
            {doc.payoutCents > 0 ? `Paid ${formatUsdCents(doc.payoutCents)}` : "Paid nothing"}
          </p>
          <p className={styles.sealedText}>
            {level ? `It settled at ${level}` : "It settled"}
            {strike ? `, ${doc.resolution === "yes" ? "at or above" : "below"} the ${strike} strike` : ""}, so
            the {doc.outcome} contracts {doc.payoutCents > 0 ? "paid $1 each" : "paid nothing"}.{" "}
            {totalsSentence({
              positions: 1,
              costCents: doc.costCents,
              payoutCents: doc.payoutCents,
              pnlCents: doc.pnlCents,
            })}
          </p>
          <dl className={styles.facts}>
            <dt>Paid</dt>
            <dd>
              <Money cents={doc.payoutCents} />
            </dd>
            <dt>Net</dt>
            <dd>
              <Money cents={doc.pnlCents} sign="always" />
            </dd>
            <dt>Outcome published</dt>
            <dd>
              <When at={doc.resolvedAt} date />
            </dd>
            <Advanced>
              <dt>Contracts</dt>
              <dd className="num">
                {formatContractsHundredths(doc.contractsHundredths)} {doc.outcome}, resolved{" "}
                {doc.resolution.toUpperCase()}
              </dd>
              <dt>Recorded</dt>
              <dd>
                Offchain in the console, <When inSentence at={settlement.storedAt} date />; the Policy
                contract cannot record a payout.
              </dd>
              <dt>Signer</dt>
              <dd>
                <HexValue value={settlement.signer} kind="address" />
              </dd>
              <dt>Hash</dt>
              <dd>
                <HexValue value={settlement.hash} kind="hash" />
              </dd>
            </Advanced>
          </dl>
        </div>
      </div>
    </Card>
  );
}

const VENUE_ORDER_STATES: Record<VenueOrderView["state"], string> = {
  placing: "Being placed",
  not_placed: "Not placed yet",
  unknown: "Being looked up",
  open: "Open",
  filled: "Filled",
  partly_filled: "Partly filled, rest cancelled",
  cancelled: "Cancelled unfilled",
  rejected: "Refused by Gemini",
};

/** The executor writes its notes as sentence fragments; shown on their own, they start with a capital. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The order the executor placed on Gemini for this intent (issue #93), from its signed journal in the
 * console. Advanced only: the Order card already says what filled.
 */
function VenueOrderFacts({ order }: { order: VenueOrderView }) {
  const where = order.environment === "production" ? "Gemini" : "Gemini sandbox";
  return (
    <Advanced>
      <dt>Venue order</dt>
      <dd data-testid="intent-venue-order">
        {order.venueOrderId === null ? (
          <span>No id from {where} yet</span>
        ) : (
          <span className="num">
            {where} #{order.venueOrderId}
          </span>
        )}
      </dd>
      {/* The executor sizes the order so its cost and Gemini's fee fit the amount, so it buys fewer
          contracts than the amount alone would at the limit (the Order row above). */}
      <dt>Order size</dt>
      <dd className="num" data-testid="intent-venue-size">
        {formatContractsHundredths(order.quantityHundredths)}{" "}
        {order.quantityHundredths === 100 ? "contract" : "contracts"}
      </dd>
      <dt>Venue state</dt>
      <dd data-testid="intent-venue-state">
        {VENUE_ORDER_STATES[order.state]}
        {order.filledHundredths > 0 && order.state !== "filled" ? (
          <span className="num">
            , {formatContractsHundredths(order.filledHundredths)} of{" "}
            {formatContractsHundredths(order.quantityHundredths)} contracts filled
          </span>
        ) : null}
      </dd>
      {order.detail ? (
        <>
          <dt>Venue note</dt>
          <dd data-testid="intent-venue-note">{sentenceCase(order.detail)}</dd>
        </>
      ) : null}
      <dt>Client order id</dt>
      <dd className="num">{order.clientOrderId}</dd>
    </Advanced>
  );
}

const FIELD_LABELS: Record<string, string> = {
  amountCents: "Amount (cents)",
  limitPrice: "Limit price",
  filledCents: "Filled (cents)",
  pnlCents: "Profit and loss (cents)",
};

/** Onchain text in full, folded away: it can be any length and was written by whoever held the agent key. */
function RawText({ what, value }: { what: string; value: string }) {
  const length = Array.from(value).length;
  if (length === 0) return <span className={styles.rawEmpty}>Empty</span>;
  return (
    <details className={styles.raw}>
      <summary className={styles.rawSummary}>
        Show the full {what} ({formatCount(length)} {length === 1 ? "character" : "characters"})
      </summary>
      <pre className={styles.rawText} translate="no" data-testid={`raw-${what}`}>
        {value}
      </pre>
    </details>
  );
}

/**
 * Why the MCP server could not have sent this intent, and every odd value exactly as stored onchain. The
 * contract still applied the amount rules; what it does not check (market, outcome, price, category) is here.
 */
function FlaggedCard({ intent, flags }: { intent: IntentView; flags: readonly string[] }) {
  const outOfRange = Object.entries(intent.outOfRange ?? {});
  const oddMarket = intent.market !== null && !isMarketSymbol(intent.market) ? intent.market : null;
  const oddOutcome =
    intent.outcome !== null && intent.outcome !== "YES" && intent.outcome !== "NO" ? intent.outcome : null;
  return (
    <Card title="Not sent by the MCP server" headingLevel={2} tone="attention">
      <div className={styles.flagged} data-testid="flagged-intent">
        <p className={styles.flaggedText}>
          The MCP server checks every proposal before it reaches the contract, so this one was sent with the
          agent&apos;s key directly. The contract still applied the amount rules, but it does not check the
          market, outcome, price or category, and the executor refuses to trade an intent like this. If you
          did not send it, pause trading and set a new agent key.
        </p>
        <ul className={styles.flaggedList}>
          {flags.map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
        {oddMarket !== null || oddOutcome !== null || outOfRange.length > 0 ? (
          <dl className={styles.facts}>
            {oddMarket !== null ? (
              <>
                <dt>Market as stored</dt>
                <dd>
                  <RawText what="market" value={oddMarket} />
                </dd>
              </>
            ) : null}
            {oddOutcome !== null ? (
              <>
                <dt>Outcome as stored</dt>
                <dd>
                  <RawText what="outcome" value={oddOutcome} />
                </dd>
              </>
            ) : null}
            {outOfRange.map(([field, digits]) => (
              <Fragment key={field}>
                <dt>{FIELD_LABELS[field] ?? field}</dt>
                <dd className={styles.digits} translate="no">
                  {digits}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
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
  const market = intent.market ? describeMarket(intent.market, namingCategory(intent)) : null;
  const venueOrder: VenueOrderView | undefined = chain.venueOrders[intent.id];
  const simulated = fillsAreSimulated(snapshot.network, venueOrder !== undefined);
  const timeline = steps(chain, intent.id, simulated);
  const flags = intentFlags(intent);
  const settlement: SettlementView | undefined = chain.settlements[intent.id];

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
            <FlaggedBadge flags={flags} />
            <span>
              Proposed <When inSentence at={intent.proposedAt} date />
            </span>
          </>
        }
      />

      <div className={styles.layout}>
        <div className={styles.main}>
          {flags.length > 0 ? <FlaggedCard intent={intent} flags={flags} /> : null}
          <Card title="Order" headingLevel={2}>
            <dl className={styles.facts}>
              <dt>Market</dt>
              <dd>
                <MarketName
                  symbol={intent.market}
                  category={intent.category}
                  listing={intent.listing}
                  showCategory={false}
                />
              </dd>
              <dt>Category</dt>
              <dd>{categoryName(intent.category)}</dd>
              <dt>Order</dt>
              <dd>
                <OrderSummary intent={intent} />
              </dd>
              <dt>Amount</dt>
              <dd>
                {intent.amountCents === null ? amountLabel(intent) : <Money cents={intent.amountCents} />}
              </dd>
              {intent.filledCents !== null ? (
                <>
                  <dt>Filled</dt>
                  <dd className={styles.filled}>
                    <Money cents={intent.filledCents} />
                    {simulated && intent.status === "executed" ? <SimulatedFill /> : null}
                  </dd>
                  <dt>Realized P&amp;L</dt>
                  <dd>
                    {intent.pnlCents === null ? (
                      intent.outOfRange?.["pnlCents"] === undefined ? (
                        "Not recorded"
                      ) : (
                        "Out of range"
                      )
                    ) : (
                      <Money cents={intent.pnlCents} sign="always" />
                    )}
                  </dd>
                </>
              ) : null}
              {venueOrder ? <VenueOrderFacts order={venueOrder} /> : null}
              {intent.agent ? (
                <Advanced>
                  <dt>Agent</dt>
                  <dd>
                    <HexValue value={intent.agent} kind="address" />
                  </dd>
                </Advanced>
              ) : null}
            </dl>
            {intent.status === "needs_approval" ? (
              <div className={styles.decide}>
                <ApprovalActions intent={intent} warn />
              </div>
            ) : null}
          </Card>

          {settlement ? <SettlementCard settlement={settlement} /> : null}

          <SealedReasonCard
            sealed={chain.sealed[intent.id]}
            market={intent.market}
            payments={new Set(snapshot.offchain.signalPayments.map((payment) => payment.receiptId))}
          />
        </div>

        <Card
          title="Onchain steps"
          description="What the contract recorded for this intent, oldest first."
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
                    <Advanced fallback={<When at={step.timestamp} />}>
                      <span>
                        <When at={step.timestamp} />, block {formatCount(step.blockNumber)}
                      </span>
                      <HexValue value={step.txHash} kind="tx" />
                    </Advanced>
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
