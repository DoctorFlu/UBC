import { CATEGORY_LABELS, categoriesFromMask } from "@mandate/shared";
import type { ReactNode } from "react";
import type { Address } from "viem";

import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
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
    cell: (intent) => (
      <span className={styles.when}>
        <span>{formatTimeUtc(isoFromUnix(intent.proposedAt))}</span>
        <span className={styles.date}>{formatDateUtc(isoFromUnix(intent.proposedAt))}</span>
      </span>
    ),
    nowrap: true,
  },
  {
    key: "market",
    header: "Market",
    cell: (intent) => (
      <span className={styles.market}>
        <span>
          <span className="visually-hidden">Intent </span>#{intent.id} {intent.title}
        </span>
        {intent.symbol ? <span className={`mono ${styles.symbol}`}>{intent.symbol}</span> : null}
      </span>
    ),
    role: "primary",
  },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) => (intent.amountCents === null ? "Unknown" : <Money cents={intent.amountCents} />),
    align: "end",
    nowrap: true,
  },
  {
    key: "verdict",
    header: "Where it stands",
    cell: (intent) => <StatusChip status={intent.status} reason={intent.reason} />,
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
              {entry.intentId === null ? "Mandate" : `Intent #${entry.intentId.toString()}`}
            </span>
            <span className={styles.proofWhen}>
              {at(entry.at)}, block {formatCount(entry.blockNumber)}
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
  const { atProposal, owner: decisions, fills, mandate } = card;
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
        description={`An AI agent trading prediction markets under an onchain mandate${agent.pairedAt ? ` since ${formatDateUtc(agent.pairedAt)}` : ""}. Its owner sets the limits; a contract on ${network.name} enforces them, and every number below is read from that contract's events.`}
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
            label="Inside the mandate"
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
            label="Realized result"
            value={<span className="num">{formatUsdCentsDelta(fills.realizedPnlCents)}</span>}
            hint={`Across ${formatCount(fills.filled.count)} ${fills.filled.count === 1 ? "fill" : "fills"}`}
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
            <p className={styles.none}>Nothing blocked. Every intent so far was inside the mandate.</p>
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
          description="What the executor recorded on the contract for approved intents."
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
            <CountRow
              label="Realized result"
              counted={fills.filled}
              value={formatUsdCentsDelta(fills.realizedPnlCents)}
              testId="realized"
            />
          </ul>
          <p className={styles.note}>
            {fills.open === 0
              ? "No approved intent is waiting for a result."
              : `${formatCount(fills.open)} approved ${fills.open === 1 ? "intent has" : "intents have"} no result yet.`}
          </p>
        </Card>
      </div>

      <Card
        title="The mandate"
        description={
          rules
            ? `Version ${mandate.version.toString()}${mandate.paused ? ", paused: the contract rejects every new intent" : ""}.`
            : "The owner has not signed a mandate yet, so the contract rejects every intent."
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
              label="Owner signs above"
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
              This agent has not sent an intent under its mandate.
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
