"use client";

import type { PolicyRules } from "@mandate/shared";
import { FlaskConical } from "lucide-react";

import { IntentLink, MarketName } from "@/components/domain/Intent";
import { EmptyState } from "@/components/ui/States";
import { StatusChip, type StatusKind } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { formatCount, formatUsdCents } from "@/lib/format";
import type { ChainView } from "@/lib/live/types";

import { type ReplayedIntent, type Verdict, type VerdictCounts, backtest } from "./backtest";
import styles from "./rules.module.css";

/**
 * A verdict at proposal. "Held" rather than the live "Waiting": the owner may since have approved and
 * the executor filled it, which a replay of the rules does not decide.
 */
function chip(verdict: Verdict | null) {
  if (!verdict) return <span className={styles.muted}>Unknown</span>;
  const status: StatusKind =
    verdict.kind === "approved" ? "approved" : verdict.kind === "held" ? "needs_approval" : "rejected";
  return (
    <StatusChip
      status={status}
      reason={verdict.kind === "rejected" ? verdict.reason : null}
      label={verdict.kind === "held" ? "Held for you" : undefined}
    />
  );
}

const columnsFor = (subject: string): readonly Column<ReplayedIntent>[] => [
  { key: "id", header: "Intent", cell: (intent) => <IntentLink id={intent.id} />, nowrap: true },
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName symbol={intent.market} />,
    role: "primary",
  },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) => (intent.amountCents === null ? "Unknown" : formatUsdCents(intent.amountCents)),
    align: "end",
    nowrap: true,
  },
  { key: "was", header: "Verdict at proposal", cell: (intent) => chip(intent.actual) },
  { key: "draft", header: `At proposal, under ${subject}`, cell: (intent) => chip(intent.draft) },
];

const KINDS: readonly { key: keyof VerdictCounts; label: string }[] = [
  { key: "approved", label: "Approved" },
  { key: "held", label: "Held for you" },
  { key: "rejected", label: "Blocked" },
];

function delta(now: number, was: number): string {
  if (now === was) return "same as before";
  return `${now > was ? "+" : "−"}${formatCount(Math.abs(now - was))} from ${formatCount(was)}`;
}

/**
 * The draft replayed against every intent the console has stored, with the shared evaluator the
 * contract is tested against. It recomputes on every keystroke: nothing is sent or signed.
 */
export function BacktestPanel({
  chain,
  draft,
  subject = "the draft",
}: {
  chain: Pick<ChainView, "events" | "intents">;
  /** The complete rules to replay, or null while the draft has an error. */
  draft: PolicyRules | null;
  /** How the rules are named in sentences, e.g. "the draft" or "the requested rules". */
  subject?: string;
}) {
  if (chain.intents.length === 0) {
    return (
      <EmptyState plain icon={<FlaskConical strokeWidth={1.75} />} title="Nothing to replay yet">
        Once the agent has proposed intents, this replays them through {subject} before you sign it.
      </EmptyState>
    );
  }
  if (!draft) {
    return (
      <p className={styles.noChanges} data-testid="backtest" data-state="invalid">
        Fix the values marked above to replay {subject}.
      </p>
    );
  }

  const result = backtest(chain, draft);
  const replayed = result.intents.length - result.unknown;
  return (
    <div className={styles.backtest} data-testid="backtest" data-changed={result.changed.length}>
      <dl className={styles.verdicts}>
        {KINDS.map(({ key, label }) => (
          <div key={key} className={styles.verdict} data-kind={key}>
            <dt>{label}</dt>
            <dd className={styles.verdictValue}>{formatCount(result.draft[key])}</dd>
            <dd className={styles.verdictWas}>{delta(result.draft[key], result.actual[key])}</dd>
          </div>
        ))}
      </dl>

      <p className={styles.backtestSummary} role="status">
        {result.changed.length === 0
          ? `No verdict changes: all ${formatCount(replayed)} past intents get the same answer under ${subject}.`
          : `${formatCount(result.changed.length)} of ${formatCount(replayed)} past intents would get a different answer under ${subject}.`}
        {result.unknown > 0
          ? ` ${formatCount(result.unknown)} could not be replayed: the console has no amount or category for them.`
          : ""}
      </p>

      {result.changed.length > 0 ? (
        <div className={styles.backtestTable}>
          <Table
            caption={`Intents whose verdict changes under ${subject}`}
            captionHidden
            columns={columnsFor(subject)}
            rows={result.changed}
            rowKey={(intent) => intent.id.toString()}
          />
        </div>
      ) : null}

      <details className={styles.limits}>
        <summary>What a backtest cannot know</summary>
        <ul>
          <li>
            Fills and losses of intents the contract stopped. A buy {subject} would approve is counted as
            committed in full, with no fill and no loss, because it never traded.
          </li>
          <li>
            Your answer to an intent {subject} would hold but the contract did not. It stays held, and its
            fill and loss are left out.
          </li>
          <li>
            What the agent would have done differently. It plans within the rules it sees, so under {subject}{" "}
            it might have proposed other intents altogether.
          </li>
          <li>
            The kill switch: each intent is replayed with the pause state it met, since signing rules never
            pauses or resumes the agent.
          </li>
        </ul>
      </details>
    </div>
  );
}
