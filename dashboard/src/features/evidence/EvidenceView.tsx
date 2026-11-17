"use client";

import { describeReason } from "@mandate/shared";
import { ArrowLeft, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { ViewLink } from "@/components/ui/ViewLink";
import type { ReactNode } from "react";

import { FlaggedBadge, IntentLink, MarketName, amountLabel, intentFlags } from "@/components/domain/Intent";
import { RequestText } from "@/components/domain/RequestText";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Advanced, useAdvanced } from "@/lib/advanced/Advanced";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import { When } from "@/components/ui/When";
import {
  type ChainIntent,
  type ChainStatus,
  type ChainTx,
  type EvidenceChain,
  type SealState,
  chainHeadline,
  evidenceChain,
} from "@/lib/evidence/chain";
import { formatContractsHundredths, formatUsdCents } from "@/lib/format";
import type { AgentPlanView } from "@/lib/hedge/types";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { isoFromUnix } from "@/lib/live/derive";
import type { ConsoleNetwork, ConsoleSnapshot } from "@/lib/live/types";
import { describeMarket, namingCategory } from "@/lib/markets";
import { paymentHref } from "@/lib/payments/links";
import { formatUsdc } from "@/lib/payments/usdc";
import { clip } from "@/lib/text";

import styles from "./evidence.module.css";

/** Agent-supplied and onchain strings are clipped to these lengths; the full value stays copyable. */
const MAX_SYMBOL = 64;
const MAX_ID = 48;

const STATUS: Record<ChainStatus, { label: string; tone: "good" | "bad" | "attention" | "muted" }> = {
  verified: { label: "Verified", tone: "good" },
  tampered: { label: "Tampered", tone: "bad" },
  not_stored: { label: "Not stored", tone: "attention" },
  signal_unlinked: { label: "Signal not named", tone: "attention" },
  not_executed: { label: "Not executed", tone: "muted" },
};

const SEAL: Record<SealState, { label: string; tone: "good" | "bad" | "muted" }> = {
  verified: { label: "Verified", tone: "good" },
  tampered: { label: "Tampered", tone: "bad" },
  not_stored: { label: "Not stored", tone: "muted" },
  none: { label: "No reason", tone: "muted" },
};

const ATTRIBUTION: Record<ChainIntent["attribution"], string> = {
  cites: "Its sealed reason names this plan and hashes to the chain.",
  claims: "Its stored reason names this plan, but no longer hashes to the chain: the claim proves nothing.",
  matches:
    "It matches an order of this plan by market and amount, but has no sealed reason the console can check.",
};

const SIGNAL_IGNORED: Record<string, string> = {
  asset_mismatch: "it was about another asset",
  event_mismatch: "it was about another expiry",
  no_matching_strikes: "none of its strikes are on this ladder",
};

function Lamp({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return (
    <span className={styles.lampChip} data-tone={tone} data-testid={testId}>
      <span className={styles.lamp} aria-hidden />
      {children}
    </span>
  );
}

/** A transaction and its time: the explorer link on Arc, the hash to copy on the local chain. */
function Tx({ tx }: { tx: ChainTx }) {
  const iso = isoFromUnix(tx.at);
  return (
    <span className={styles.tx}>
      <When at={iso} date className={styles.txTime} />
      <Advanced>
        <HexValue value={tx.txHash} kind="tx" />
      </Advanced>
    </span>
  );
}

/** One link of the chain: a numbered marker on the rail, then its record. */
function ChainLink({
  index,
  tone,
  title,
  aside,
  children,
  testId,
}: {
  index: number;
  tone: "good" | "bad" | "attention" | "muted";
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <li className={styles.link} data-tone={tone} data-testid={testId}>
      <span className={styles.marker} aria-hidden>
        {index}
      </span>
      <Card title={title} actions={aside} headingLevel={2} className={styles.linkCard}>
        {children}
      </Card>
    </li>
  );
}

function StatusCard({ evidence, network }: { evidence: EvidenceChain; network: ConsoleNetwork }) {
  const { advanced } = useAdvanced();
  const Icon =
    evidence.status === "verified"
      ? ShieldCheck
      : evidence.status === "tampered"
        ? ShieldAlert
        : ShieldQuestion;
  return (
    <Card
      tone={evidence.status === "verified" || evidence.status === "not_executed" ? "default" : "attention"}
    >
      <div className={styles.status} data-status={evidence.status} data-testid="chain-status">
        <Icon aria-hidden className={styles.statusIcon} />
        <div className={styles.statusBody}>
          <p className={styles.statusTitle}>{chainHeadline(evidence)}</p>
          {evidence.gaps.length > 0 ? (
            <ul className={styles.gaps} data-testid="chain-gaps">
              {evidence.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          ) : null}
          <p className={styles.note}>
            {!advanced
              ? "Advanced view shows the transaction behind each step, to check it onchain."
              : network.explorerUrl
                ? `Each transaction opens on the ${network.name} explorer.`
                : "This is the local chain, which has no explorer: copy a transaction hash to check it with any RPC client."}
          </p>
        </div>
      </div>
    </Card>
  );
}

function RequestLink({ view }: { view: AgentPlanView }) {
  return (
    <ChainLink index={1} tone="good" title="Your request" testId="evidence-request">
      {view.requestText ? (
        <blockquote className={styles.quote}>
          <RequestText text={view.requestText} />
        </blockquote>
      ) : (
        <p className={styles.muted}>The agent stored the plan without the request that led to it.</p>
      )}
      <p className={styles.note}>
        As the agent reported it with the plan, <When inSentence at={view.createdAt} date />.
      </p>
    </ChainLink>
  );
}

function SignalLink({ view, evidence }: { view: AgentPlanView; evidence: EvidenceChain }) {
  const signal = view.plan.signal;
  if (!signal || evidence.receiptId === null) {
    return (
      <ChainLink index={2} tone="muted" title="Paid signal" testId="evidence-signal">
        <p className={styles.muted}>None. The plan used Gemini&apos;s quotes only, so there is no receipt.</p>
      </ChainLink>
    );
  }
  const payment = evidence.payment;
  const use = signal.used
    ? signal.changedOrders
      ? "Used, and it changed which rungs were bought."
      : "Used; the orders are the same as without it."
    : `Bought but ignored, because ${SIGNAL_IGNORED[signal.ignoredBecause ?? ""] ?? "it did not fit this ladder"}.`;
  return (
    <ChainLink
      index={2}
      tone={payment ? "good" : "attention"}
      title="Paid signal"
      aside={
        payment ? (
          <ArrowLink view href={paymentHref(evidence.receiptId)}>
            Payment record
          </ArrowLink>
        ) : undefined
      }
      testId="evidence-signal"
    >
      <dl className={styles.facts}>
        <Advanced>
          <dt>Receipt</dt>
          <dd>
            <HexValue value={clip(signal.receiptId, 80)} kind="hash" />
          </dd>
        </Advanced>
        {payment ? (
          <>
            <dt>Price</dt>
            <dd className="num">{formatUsdc(payment.amount)}</dd>
            <dt>Paid</dt>
            <dd>
              <When at={payment.paidAt} date />
            </dd>
            <Advanced>
              <dt>Network</dt>
              <dd className="mono">{clip(payment.network, MAX_SYMBOL)}</dd>
              <dt>Gateway settlement</dt>
              <dd>
                {payment.settlementId ? (
                  <span className={styles.copyable}>
                    <span className="mono" title="A Circle Gateway reference, not an onchain transaction">
                      {clip(payment.settlementId, MAX_ID)}
                    </span>
                    <CopyButton value={payment.settlementId} what="settlement reference" />
                  </span>
                ) : (
                  <span className={styles.muted}>The seller gave no settlement reference.</span>
                )}
              </dd>
            </Advanced>
          </>
        ) : (
          <>
            <dt>Payment</dt>
            <dd className={styles.attention}>The agent never reported this payment to the console.</dd>
          </>
        )}
        <dt>In the plan</dt>
        <dd>{use}</dd>
      </dl>
    </ChainLink>
  );
}

function PlanLink({
  view,
  evidence,
  current,
}: {
  view: AgentPlanView;
  evidence: EvidenceChain;
  current: boolean;
}) {
  const { plan } = view;
  const unproposed = evidence.unproposed.flatMap((index) => {
    const order = plan.orders[index];
    return order ? [{ index, order }] : [];
  });
  return (
    <ChainLink
      index={3}
      tone="good"
      title="The plan"
      aside={
        current ? (
          <ArrowLink view href={`/hedge?asset=${encodeURIComponent(view.asset)}`}>
            Hedge page
          </ArrowLink>
        ) : undefined
      }
      testId="evidence-plan"
    >
      <dl className={styles.facts}>
        <dt>Plan</dt>
        <dd>
          <span className={styles.copyable}>
            <span className="mono">{clip(view.planId, MAX_ID)}</span>
            <CopyButton value={view.planId} what="plan id" />
          </span>
        </dd>
        <dt>Planned</dt>
        <dd>
          <When at={view.createdAt} date />
        </dd>
        <dt>Costs</dt>
        <dd>
          <Money cents={plan.totals.costCents} />, for{" "}
          {formatContractsHundredths(plan.totals.contractsHundredths)} contracts in{" "}
          {plan.orders.length.toString()} {plan.orders.length === 1 ? "order" : "orders"}
        </dd>
        <dt>Pays at most</dt>
        <dd>
          <Money cents={plan.totals.maxPayoutCents} />
        </dd>
        <Advanced>
          <dt>Event</dt>
          <dd className="mono">{clip(plan.eventTicker, MAX_SYMBOL)}</dd>
        </Advanced>
      </dl>
      {current ? null : (
        <p className={styles.note}>
          A newer {clip(view.asset, 12)} plan has replaced this one on the hedge page; this is its record.
        </p>
      )}
      {unproposed.length > 0 ? (
        <div className={styles.unproposed}>
          <p className={styles.subhead}>Never proposed</p>
          <ul>
            {unproposed.map(({ index, order }) => (
              <li key={index}>
                <Advanced fallback={<span>{describeMarket(order.instrumentSymbol).title}</span>}>
                  <span className="mono">{clip(order.instrumentSymbol, MAX_SYMBOL)}</span>
                </Advanced>
                <span className="num">{formatUsdCents(order.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ChainLink>
  );
}

function IntentRecord({ entry, index }: { entry: ChainIntent; index: number }) {
  const { intent } = entry;
  // The title never quotes onchain text: a market that is not a Gemini symbol reads "Not a Gemini market".
  const title =
    intent.market === null
      ? "Market not recorded"
      : describeMarket(intent.market, namingCategory(intent)).title;
  const flags = intentFlags(intent);
  const seal = SEAL[entry.seal];
  const tone =
    entry.seal === "verified"
      ? entry.namesReceipt === false
        ? "attention"
        : "good"
      : entry.seal === "tampered"
        ? "bad"
        : "attention";
  return (
    <ChainLink
      index={index}
      tone={tone}
      title={
        <span className={styles.intentTitle}>
          <IntentLink id={intent.id} />
          <span className={styles.intentMarket}>{title}</span>
        </span>
      }
      aside={
        <span className={styles.badges}>
          <FlaggedBadge flags={flags} />
          <Lamp tone={seal.tone} testId="intent-seal">
            {seal.label}
          </Lamp>
        </span>
      }
      testId="evidence-intent"
    >
      <p className={styles.attribution}>
        {ATTRIBUTION[entry.attribution]}
        {entry.namesReceipt === false ? " It does not name the plan's paid signal." : ""}
      </p>
      <dl className={styles.facts}>
        <dt>Order</dt>
        <dd className={styles.order}>
          <span className="num">{amountLabel(intent)}</span>
          <MarketName symbol={intent.market} category={intent.category} listing={intent.listing} />
        </dd>
        <dt>Proposed</dt>
        <dd>
          <Tx tx={entry.proposed} />
        </dd>
        <dt>Contract verdict</dt>
        <dd>
          {entry.verdict ? (
            <span className={styles.step}>
              <StatusChip
                status={
                  entry.verdict.kind === "approved"
                    ? "approved"
                    : entry.verdict.kind === "held"
                      ? "needs_approval"
                      : "rejected"
                }
                reason={entry.verdict.kind === "rejected" ? entry.verdict.reason : null}
                label={entry.verdict.kind === "held" ? "Held for you" : undefined}
              />
              <Tx tx={entry.verdict.tx} />
            </span>
          ) : (
            <span className={styles.muted}>No verdict recorded yet.</span>
          )}
        </dd>
        {entry.verdict?.kind === "held" ? (
          <>
            <dt>Your decision</dt>
            <dd>
              {entry.owner ? (
                <span className={styles.step}>
                  <span>
                    {entry.owner.kind === "approved"
                      ? "Approved by you"
                      : entry.owner.kind === "rejected"
                        ? "Rejected by you"
                        : `Approved by you, then rejected on the contract's re-check: ${describeReason(entry.owner.reason).label}`}
                  </span>
                  <Tx tx={entry.owner.tx} />
                </span>
              ) : (
                <span className={styles.attention}>Waiting for you.</span>
              )}
            </dd>
          </>
        ) : null}
        <dt>Fill</dt>
        <dd>
          {entry.fill ? (
            <span className={styles.step}>
              <span>
                {entry.fill.filled ? (
                  <>
                    Filled{" "}
                    {entry.fill.filledCents === null ? (
                      "an amount out of range"
                    ) : (
                      <Money cents={entry.fill.filledCents} />
                    )}
                    ; result recorded at the fill{" "}
                    {entry.fill.pnlCents === null ? (
                      "a result out of range"
                    ) : (
                      <Money cents={entry.fill.pnlCents} sign="always" />
                    )}
                  </>
                ) : (
                  "Did not fill"
                )}
              </span>
              <Tx tx={entry.fill.tx} />
            </span>
          ) : (
            <span className={styles.muted}>
              {intent.status === "rejected" ? "None: the intent was rejected." : "No result recorded yet."}
            </span>
          )}
        </dd>
      </dl>
    </ChainLink>
  );
}

/**
 * The evidence chain of one plan, in order: the owner's request, the paid signal, the plan, and each
 * intent with the contract's verdict, the owner's decision and the fill. The plan comes from the server
 * (it never changes once stored); everything else follows the live snapshot.
 */
export function EvidenceView({ view, preview }: { view: AgentPlanView; preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const evidence = evidenceChain(view, snapshot.chain, snapshot.offchain.signalPayments);
  const current = snapshot.offchain.plans.some((plan) => plan.planId === view.planId);
  const status = STATUS[evidence.status];
  return (
    <div className={styles.view}>
      <ViewLink href={`/hedge?asset=${encodeURIComponent(view.asset)}`} className={styles.back}>
        <ArrowLeft aria-hidden className={styles.backIcon} strokeWidth={2} />
        Hedge
      </ViewLink>
      <PageHeader
        title="Evidence chain"
        description={`From your request to the fill, for the agent's ${clip(view.asset, 12)} hedge plan. Each link opens the record behind it.`}
        meta={
          <>
            <Lamp tone={status.tone} testId="chain-status-chip">
              {status.label}
            </Lamp>
            <span>
              Planned <When inSentence at={view.createdAt} date />
            </span>
          </>
        }
      />
      <StatusCard evidence={evidence} network={snapshot.network} />
      <ol className={styles.chain} aria-label="Evidence chain, in order">
        <RequestLink view={view} />
        <SignalLink view={view} evidence={evidence} />
        <PlanLink view={view} evidence={evidence} current={current} />
        {evidence.intents.map((entry, index) => (
          <IntentRecord key={entry.intent.id} entry={entry} index={4 + index} />
        ))}
        {evidence.intents.length === 0 ? (
          <ChainLink index={4} tone="muted" title="Intents" testId="evidence-no-intents">
            <p className={styles.muted}>
              No intent on the chain carries out this plan yet. When the agent proposes its orders, each
              appears here with the contract&apos;s verdict, your decision where one was needed, and the fill.
            </p>
          </ChainLink>
        ) : null}
      </ol>
    </div>
  );
}
