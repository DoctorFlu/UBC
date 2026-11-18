import { CATEGORY_LABELS, categoriesFromMask } from "@mandate/shared";
import type { ReactNode } from "react";
import type { Address } from "viem";

import { FlaggedBadge, MarketName } from "@/components/domain/Intent";
import { StatusChip } from "@/components/ui/StatusChip";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { When } from "@/components/ui/When";
import {
  formatCount,
  formatDateUtc,
  formatPercentBps,
  formatTimeUtc,
  formatUsdCents,
  formatUsdCentsDelta,
  shareBps,
} from "@/lib/format";
import { isoFromUnix } from "@/lib/live/derive";
import type { ConsoleNetwork } from "@/lib/live/types";
import { explorerAddressUrl } from "@/lib/network";
import {
  type Counted,
  PROOF_LIMIT,
  type Proof,
  type PublicScorecard,
  type RecentIntent,
} from "@/lib/scorecard/scorecard";

import styles from "./scorecard.module.css";

export interface ScorecardData {
  agent: { address: Address; name: string; pairedAt: string | null };
  owner: Address;
  contract: Address;
  network: ConsoleNetwork;
  card: PublicScorecard;
}

const at = (unix: number) => `${formatDateUtc(isoFromUnix(unix))}, ${formatTimeUtc(isoFromUnix(unix))}`;

const columns: readonly Column<RecentIntent>[] = [
  {
    key: "time",
    header: "Time",
    cell: (intent) => <When at={intent.proposedAt} className={styles.when} dateClassName={styles.date} />,
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: (intent) => (
      <span className={styles.market}>
        <span className={styles.intentId}>
          <span className="visually-hidden">Intent </span>#{intent.id}
        </span>
        <MarketName symbol={intent.market} category={intent.category} />
      </span>
    ),
    role: "primary",
  },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) =>
      intent.amountCents !== null ? (
        <Money cents={intent.amountCents} />
      ) : intent.amountOutOfRange ? (
        "Out of range"
      ) : (
        "Unknown"
      ),
    align: "end",
    nowrap: true,
  },
  {
    key: "verdict",
    header: "Where it stands",
    cell: (intent) => (
      <span className={styles.verdict}>
        <StatusChip status={intent.status} reason={intent.reason} />
        <FlaggedBadge flags={intent.flags} />
      </span>
    ),
  },
  {
    key: "tx",
    header: "Transaction",
    cell: (intent) => <HexValue value={intent.txHash} kind="tx" />,
    nowrap: true,
  },
];

/** The transactions behind a number, newest first, each one checkable onchain. */
function Proofs({ counted }: { counted: Counted }) {
  if (counted.count === 0) return null;
  const summary =
    counted.count > PROOF_LIMIT
      ? `Newest ${formatCount(PROOF_LIMIT)} of ${formatCount(counted.count)} transactions`
      : `${formatCount(counted.count)} ${counted.count === 1 ? "transaction" : "transactions"}`;
  return (
    <details className={styles.proofs}>
      <summary>{summary}</summary>
      <ul>
        {counted.proofs.map((entry: Proof) => (
          <li key={`${entry.txHash}:${String(entry.intentId)}`}>
            <span className={styles.proofWhat}>
              {entry.intentId === null ? "Rules" : `Intent #${entry.intentId.toString()}`}
            </span>
            <span className={styles.proofWhen}>
              <When at={entry.at} date />, block {formatCount(entry.blockNumber)}
            </span>
            <HexValue value={entry.txHash} kind="tx" />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One number with what it counts and the transactions behind it. */
function CountRow({
  label,
  code,
  counted,
  value,
  testId,
}: {
  label: string;
  code?: string;
  counted: Counted;
  value?: ReactNode;
  testId: string;
}) {
  return (
    <li className={styles.row} data-testid={testId} data-count={counted.count}>
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>
          {label}
          {code ? <span className={`mono ${styles.code}`}>{code}</span> : null}
        </span>
        <span className={`num ${styles.rowValue}`}>{value ?? formatCount(counted.count)}</span>
      </div>
      <Proofs counted={counted} />
    </li>
  );
}

/**
 * The agent's record as anyone can check it, with no wallet and nothing offchain: every number is read
 * from the Policy contract's events, matches the owner's audit trail, and lists the transactions behind it.
 */
export function ScorecardView({ agent, owner, contract, network, card }: ScorecardData) {
  const { atProposal, owner: decisions, fills, mandate, settled } = card;
  const proposed = card.proposed.count;
  const inside = atProposal.approved.count + atProposal.held.count;
  const rules = mandate.rules;
  const markets = rules
    ? categoriesFromMask(rules.allowedCategories)
        .map((category) => CATEGORY_LABELS[category])
        .join(", ") || "None"
    : null;
  const contractUrl = explorerAddressUrl(network, contract);

  return (
    <div className={styles.view}>
      <PageHeader
        title={agent.name}
        description={`An AI agent trading prediction markets under onchain rules${agent.pairedAt ? ` since ${formatDateUtc(agent.pairedAt)}` : ""}. Its owner sets the limits; a contract on ${network.name} enforces them, and every number below is read from that contract's events, except what positions paid at expiry, which the executor signs offchain.`}
        meta={
          <>
            <HexValue label="Agent" value={agent.address} kind="address" />
            <HexValue label="Owner" value={owner} kind="address" />
            <HexValue label="Contract" value={contract} kind="address" />
          </>
        }
      />

      <Card>
        <StatGroup>
          <Stat label="Intents proposed" value={formatCount(proposed)} />
          <Stat
            label="Inside the rules"
            value={
              proposed > 0 ? formatPercentBps(shareBps(inside, proposed), { fractionDigits: 0 }) : "None yet"
            }
            hint={`${formatCount(inside)} of ${formatCount(proposed)} at proposal`}
          />
          <Stat label="Blocked by the contract" value={formatCount(card.blockedTotal)} />
          <Stat
            label="Owner decisions"
            value={formatCount(decisions.approvals.count + decisions.rejections.count)}
            hint={`${formatCount(decisions.waiting)} waiting now`}
          />
          <Stat
            label="Settled result"
            value={<span className="num">{formatUsdCentsDelta(settled.pnlCents)}</span>}
            hint={
              settled.positions === 0
                ? "Nothing settled yet"
                : `Across ${formatCount(settled.positions)} settled ${settled.positions === 1 ? "position" : "positions"}` +
                  (settled.feesEstimated ? ", after fees (estimated)" : "")
            }
          />
        </StatGroup>
      </Card>

      <div className={styles.grid}>
        <Card
          title="Verdicts at proposal"
          description="What the contract answered in the transaction that proposed each intent."
          headingLevel={2}
        >
          <ul className={styles.rows} data-testid="verdicts">
            <CountRow label="Proposed" counted={card.proposed} testId="count-proposed" />
            <CountRow label="Approved" counted={atProposal.approved} testId="count-approved" />
            <CountRow label="Held for the owner" counted={atProposal.held} testId="count-held" />
            <CountRow label="Rejected" counted={atProposal.rejected} testId="count-rejected" />
          </ul>
        </Card>

        <Card
          title="Blocked attempts, by rule"
          description="Every rejection by the contract, by the rule that stopped it, including approvals that failed the contract's re-check."
          headingLevel={2}
        >
          {card.blocked.length === 0 ? (
            <p className={styles.none}>Nothing blocked. Every intent so far was inside the rules.</p>
          ) : (
            <ul className={styles.rows} data-testid="blocked-by-rule">
              {card.blocked.map((rule) => (
                <CountRow
                  key={rule.reason}
                  label={rule.label}
                  code={rule.reason}
                  counted={rule}
                  testId="count-blocked"
                />
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Owner decisions"
          description="The owner's answers to intents the contract held for approval, each its own transaction."
          headingLevel={2}
        >
          <ul className={styles.rows}>
            <CountRow
              label="Approved by the owner"
              counted={decisions.approvals}
              testId="count-owner-approved"
            />
            <CountRow
              label="Rejected by the owner"
              counted={decisions.rejections}
              testId="count-owner-rejected"
            />
          </ul>
          <p className={styles.note}>
            {decisions.waiting === 0
              ? "Nothing is waiting for the owner."
              : `${formatCount(decisions.waiting)} ${decisions.waiting === 1 ? "intent is" : "intents are"} waiting for the owner now.`}
          </p>
        </Card>

        <Card
          title="Fills and hedge outcome"
          description="What the executor recorded on the contract for approved intents, and what they paid at expiry."
          headingLevel={2}
        >
          <ul className={styles.rows}>
            <CountRow
              label="Filled"
              counted={fills.filled}
              value={
                <>
                  {formatCount(fills.filled.count)}
                  <span className={styles.rowSub}>{formatUsdCents(fills.filledCents)}</span>
                </>
              }
              testId="count-filled"
            />
            <CountRow label="Did not fill" counted={fills.notFilled} testId="count-not-filled" />
            <li className={styles.row} data-testid="count-settled" data-count={settled.positions}>
              <div className={styles.rowHead}>
                <span className={styles.rowLabel}>Settled at expiry</span>
                <span className={`num ${styles.rowValue}`}>
                  {formatCount(settled.positions)}
                  <span className={styles.rowSub}>
                    {settled.positions === 0
                      ? "none yet"
                      : `paid ${formatUsdCents(settled.payoutCents)}` +
                        (settled.feesEstimated ? `, fees ${formatUsdCents(settled.feeCents)}` : "") +
                        `, net ${formatUsdCentsDelta(settled.pnlCents)}`}
                  </span>
                </span>
              </div>
            </li>
          </ul>
          <p className={styles.note} data-testid="settled-note">
            {settled.positions === 0
              ? "No filled position has reached its market's expiry and settled yet."
              : `${formatCount(settled.paidOut)} of ${formatCount(settled.positions)} settled ${settled.positions === 1 ? "position" : "positions"} paid out. `}
            Settlements are recorded offchain by the console, each signed by the contract&rsquo;s executor,
            because the contract cannot record a payout: it records each fill with a result of $0, so a
            position&rsquo;s result is its settlement.
            {settled.feesEstimated
              ? " Nets are after Gemini's fees, estimated from its published schedule (no Gemini answer reports them)."
              : null}
          </p>
          <p className={styles.note}>
            {fills.open === 0
              ? "No approved intent is waiting for a result."
              : `${formatCount(fills.open)} approved ${fills.open === 1 ? "intent has" : "intents have"} no result yet.`}
          </p>
          {fills.outOfRange > 0 ? (
            <p className={styles.note} data-testid="fills-out-of-range">
              {`${formatCount(fills.outOfRange)} ${fills.outOfRange === 1 ? "fill records" : "fills record"} an amount or result out of range; ${fills.outOfRange === 1 ? "it is" : "they are"} counted but left out of the totals.`}
            </p>
          ) : null}
        </Card>
      </div>

      <Card
        title="Rules"
        description={
          rules
            ? `Version ${mandate.version.toString()}${mandate.paused ? ", paused: the contract rejects every new intent" : ""}.`
            : "The owner has not set rules yet, so the contract rejects every intent."
        }
        actions={
          mandate.setBy ? <HexValue label="Set in" value={mandate.setBy.txHash} kind="tx" /> : undefined
        }
        headingLevel={2}
      >
        {rules ? (
          <StatGroup>
            <Stat size="sm" label="Total budget" value={formatUsdCents(rules.budgetCents)} />
            <Stat size="sm" label="Max trade" value={formatUsdCents(rules.maxTradeCents)} />
            <Stat
              size="sm"
              label="Owner approves above"
              value={rules.approvalAboveCents === 0 ? "Never" : formatUsdCents(rules.approvalAboveCents)}
            />
            <Stat
              size="sm"
              label="Daily loss limit"
              value={rules.dailyLossCents === 0 ? "Off" : formatUsdCents(rules.dailyLossCents)}
            />
            <Stat size="sm" label="Markets" value={markets} />
          </StatGroup>
        ) : null}
      </Card>

      <Card title="Recent intents" padding="flush" headingLevel={2}>
        <Table
          caption="Recent intents and where each stands now, newest first"
          captionHidden
          columns={columns}
          rows={card.recent}
          rowKey={(intent) => intent.id.toString()}
          empty={
            <EmptyState plain title="No intents yet">
              This agent has not sent an intent yet.
            </EmptyState>
          }
        />
      </Card>

      <footer className={styles.footer}>
        <p>
          As of block {formatCount(card.asOf.blockNumber)}, {at(card.asOf.timestamp)}. Every number is
          computed from the Policy contract&apos;s events and matches its owner&apos;s audit trail.{" "}
          {contractUrl ? (
            <>
              <a href={contractUrl} target="_blank" rel="noreferrer">
                The contract on the explorer
              </a>{" "}
              lists every one of them.
            </>
          ) : (
            "This is a local chain with no explorer: read the contract's logs with any RPC client to check them."
          )}
        </p>
      </footer>
    </div>
  );
}
