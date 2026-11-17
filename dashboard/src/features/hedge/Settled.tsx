"use client";

import type { Settlement } from "@mandate/shared";

import { IntentLink } from "@/components/domain/Intent";
import { Card } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { type Column, Table } from "@/components/ui/Table";
import { When } from "@/components/ui/When";
import { Advanced, useAdvancedColumns } from "@/lib/advanced/Advanced";
import { formatContractPrice, formatContractsHundredths, formatUsdCents } from "@/lib/format";
import {
  type LadderSettlementState,
  type SettledLadder,
  settledAtSentence,
  totalsSentence,
} from "@/lib/settlement/settlement";

import styles from "./CoverNow.module.css";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

/** The positions table; a fee column and "Net after fees" only when a Gemini fill paid an estimated fee. */
function positionColumns(withFee: boolean): readonly Column<Settlement>[] {
  return [
    {
      key: "strike",
      header: "Pays if below",
      cell: (doc) => <span className="num">{doc.strikeCents === null ? "-" : usd(doc.strikeCents)}</span>,
      nowrap: true,
    },
    {
      key: "contracts",
      header: "Held",
      cell: (doc) => (
        <span className="num">
          {formatContractsHundredths(doc.contractsHundredths)} {doc.outcome}
        </span>
      ),
      align: "end",
      nowrap: true,
    },
    {
      key: "limit",
      header: "Limit",
      cell: (doc) => <span className="num">{formatContractPrice(doc.limitPrice)}</span>,
      align: "end",
      nowrap: true,
      advanced: true,
    },
    {
      key: "resolved",
      header: "Resolved",
      cell: (doc) => doc.resolution.toUpperCase(),
      nowrap: true,
    },
    {
      key: "cost",
      header: "Cost",
      cell: (doc) => <Money cents={doc.costCents} />,
      align: "end",
      nowrap: true,
    },
    ...(withFee
      ? [
          {
            key: "fee",
            header: "Fee (estimated)",
            cell: (doc: Settlement) => <Money cents={doc.feeCents ?? 0} />,
            align: "end" as const,
            nowrap: true,
          },
        ]
      : []),
    {
      key: "paid",
      header: "Paid",
      cell: (doc) => <Money cents={doc.payoutCents} />,
      align: "end",
      nowrap: true,
    },
    {
      key: "net",
      header: withFee ? "Net after fees" : "Net",
      cell: (doc) => <Money cents={doc.pnlCents} sign="always" />,
      align: "end",
      nowrap: true,
    },
    { key: "intent", header: "Intent", cell: (doc) => <IntentLink id={doc.intentId} />, nowrap: true },
  ];
}

/** Every settled position of a ladder, one row per strike: the detail behind the plain sentence. */
function SettledPositions({ ladder }: { ladder: SettledLadder }) {
  const columns = useAdvancedColumns(positionColumns(ladder.totals.feesEstimated));
  return (
    <Advanced>
      <p className={styles.detail}>
        Gemini published the outcome <When inSentence at={ladder.resolvedAt} date />. The executor signed what
        each position paid and the console stored it; the Policy contract cannot record a payout.
      </p>
      <Table
        caption={`Settled positions on ${ladder.eventTicker}`}
        captionHidden
        columns={columns}
        rows={ladder.positions}
        rowKey={(doc) => doc.intentId.toString()}
      />
    </Advanced>
  );
}

function SettledBody({ ladder }: { ladder: SettledLadder }) {
  return (
    <>
      <p className={styles.sentence}>{settledAtSentence(ladder)}</p>
      <p className={styles.sentence} data-testid="settlement-totals">
        {totalsSentence(ladder.totals)}
      </p>
      <SettledPositions ladder={ladder} />
    </>
  );
}

/**
 * The plan's ladder once it has expired, in place of "Cover now": waiting for Gemini's outcome, or what the
 * positions on it cost, paid and netted. The next plan goes on the next ladder.
 */
export function ExpiredLadderCard({
  state,
  agentName,
}: {
  state: Exclude<LadderSettlementState, { state: "open" }>;
  agentName: string;
}) {
  const next = `${agentName}'s next plan goes on the next ladder.`;
  return (
    <Card
      title="Expired ladder"
      description={
        <>
          Expired <When inSentence at={state.expiresAt} date />.
        </>
      }
      headingLevel={2}
    >
      <div className={styles.cover} data-testid="ladder-expired" data-state={state.state}>
        {state.state === "nothing_filled" ? (
          <p className={styles.sentence} role="status">
            Nothing was filled on it, so there is nothing to settle. {next}
          </p>
        ) : state.state === "settling" && state.ladder === null ? (
          <p className={styles.sentence} role="status">
            Waiting for Gemini to publish the outcome. The executor records what{" "}
            {state.waiting === 1 ? "the position" : `each of the ${state.waiting.toString()} positions`} paid
            as soon as it does; nothing is guessed. {next}
          </p>
        ) : state.ladder ? (
          <>
            <SettledBody ladder={state.ladder} />
            <p className={styles.sentence} role="status">
              {state.state === "settling"
                ? `${state.waiting.toString()} more ${state.waiting === 1 ? "position waits" : "positions wait"} for Gemini's outcome. `
                : null}
              {next}
            </p>
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** The most recent ladder of this asset that settled, while the plan is on a later one. */
export function LastSettledCard({ ladder }: { ladder: SettledLadder }) {
  return (
    <Card
      title="Last settled"
      description={
        <>
          The {ladder.asset ?? ""} ladder that expired <When inSentence at={ladder.expiresAt} date />.
        </>
      }
      headingLevel={2}
    >
      <div className={styles.cover} data-testid="last-settled" data-ticker={ladder.eventTicker}>
        <SettledBody ladder={ladder} />
      </div>
    </Card>
  );
}
