import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { formatUsdCents } from "@/lib/format";
import { mandatePath } from "@/lib/mandate-path";

import { HomeWallet, MandateOwnerLine } from "./HomeWallet";
import styles from "./workspace.module.css";
import type { MandateSummary, WorkspaceHomeData } from "./types";

function signerText(summary: MandateSummary): string {
  switch (summary.mandate.ownerSigner) {
    case "console":
      return "The console holds this mandate's owner key; your passkey confirms each owner action";
    case "wallet":
      return "The owner's wallet signs";
    default:
      return "No contract yet";
  }
}

function coverText(cover: MandateSummary["cover"]): { value: string; hint: string } {
  if (cover.goals === 0) return { value: "No goals", hint: "No current hedge goal" };
  if (cover.unavailable === cover.goals) return { value: "Unknown", hint: "Can't measure it right now" };
  return {
    value: `${String(cover.met)} of ${String(cover.goals)}`,
    hint:
      cover.unavailable > 0
        ? `goals covered; ${String(cover.unavailable)} can't be measured now`
        : cover.goals === 1
          ? "goal covered"
          : "goals covered",
  };
}

/**
 * The headline across every mandate, by the same rule as each row: a goal whose cover cannot be measured
 * (Gemini's quotes unavailable) is never counted as not covered.
 */
function goalsCoveredText(cover: Pick<MandateSummary["cover"], "goals" | "met" | "unavailable">): {
  value: string;
  hint?: string;
} {
  if (cover.goals === 0) return { value: "None set" };
  if (cover.unavailable === cover.goals) return { value: "Unknown", hint: "Can't measure it right now" };
  const value = `${String(cover.met)} of ${String(cover.goals)}`;
  return cover.unavailable > 0
    ? { value, hint: `${String(cover.unavailable)} can't be measured now` }
    : { value };
}

function committedText(summary: MandateSummary): { value: string; hint: string } {
  if (summary.committedCents === null) return { value: "Unknown", hint: "The chain is not readable now" };
  return {
    value: formatUsdCents(summary.committedCents),
    hint: summary.budgetCents === null ? "No rules yet" : `of ${formatUsdCents(summary.budgetCents)} budget`,
  };
}

function MandateRow({ summary }: { summary: MandateSummary }) {
  const { mandate } = summary;
  const cover = coverText(summary.cover);
  const committed = committedText(summary);
  const headingId = `mandate-${mandate.id}`;
  return (
    <li className={styles.row} aria-labelledby={headingId} data-testid="mandate-row">
      <div className={styles.rowHead}>
        <div className={styles.rowTitle}>
          <h2 id={headingId} className={styles.rowName}>
            <Link href={mandatePath(mandate.id)} className={styles.rowLink}>
              {mandate.name}
            </Link>
          </h2>
          {mandate.ownerSigner === "wallet" ? (
            <MandateOwnerLine owner={summary.owner} />
          ) : (
            <p className={styles.rowMeta}>{signerText(summary)}</p>
          )}
        </div>
        {summary.paused ? (
          <span className={styles.paused} data-testid="mandate-paused">
            Paused
          </span>
        ) : null}
      </div>
      <div className={styles.rowStats}>
        <StatGroup className={styles.statGroup}>
          <Stat
            size="sm"
            label="Waiting for you"
            value={String(summary.waiting)}
            hint={
              summary.waiting > 0 ? (
                <Link href={mandatePath(mandate.id, "/approvals")} className={styles.inlineLink}>
                  Open approvals
                </Link>
              ) : (
                "Nothing to decide"
              )
            }
          />
          <Stat size="sm" label="Committed" value={committed.value} hint={committed.hint} />
          <Stat size="sm" label="Cover" value={cover.value} hint={cover.hint} />
        </StatGroup>
      </div>
      <Link href={mandatePath(mandate.id)} className={styles.open} aria-label={`Open ${mandate.name}`}>
        Open
        <ArrowRight aria-hidden strokeWidth={2} />
      </Link>
    </li>
  );
}

/** Every mandate of the workspace at a glance (#95): what waits for you, what is covered, what is committed. */
export function WorkspaceHome({ data }: { data: WorkspaceHomeData }) {
  const waiting = data.mandates.reduce((sum, row) => sum + row.waiting, 0);
  const committed = data.mandates.reduce((sum, row) => sum + (row.committedCents ?? 0), 0);
  const cover = data.mandates.reduce(
    (sum, row) => ({
      goals: sum.goals + row.cover.goals,
      met: sum.met + row.cover.met,
      unavailable: sum.unavailable + row.cover.unavailable,
    }),
    { goals: 0, met: 0, unavailable: 0 },
  );
  const count = data.mandates.length;
  // Wallet-owned mandates need the owner's wallet: Home offers it, as a mandate's top bar does.
  const walletOwned = data.mandates.filter((row) => row.mandate.ownerSigner === "wallet");
  const owners = walletOwned.flatMap((row) => (row.owner ? [row.owner] : []));
  const create = data.canCreate ? (
    <ButtonLink href="/mandates/new" variant="primary" icon={<Plus aria-hidden />}>
      New mandate
    </ButtonLink>
  ) : count >= data.limit ? (
    <p className={styles.limit}>
      {String(count)} of {String(data.limit)} mandates: this workspace&apos;s limit.
    </p>
  ) : null;
  return (
    <div className={styles.view}>
      <PageHeader
        title="Home"
        description={`${String(count)} ${count === 1 ? "mandate" : "mandates"} in ${data.workspaceName}. Each has its own contract, agent and rules.`}
        actions={
          walletOwned.length > 0 || create ? (
            <div className={styles.headerActions}>
              {walletOwned.length > 0 ? <HomeWallet owners={owners} /> : null}
              {create}
            </div>
          ) : undefined
        }
      />
      <section className={styles.totals} aria-label="Across every mandate">
        <StatGroup>
          <Stat label="Waiting for you" value={String(waiting)} />
          <Stat label="Committed" value={formatUsdCents(committed)} />
          <Stat label="Goals covered" {...goalsCoveredText(cover)} />
        </StatGroup>
      </section>
      <ul className={styles.rows}>
        {data.mandates.map((summary) => (
          <MandateRow key={summary.mandate.id} summary={summary} />
        ))}
      </ul>
    </div>
  );
}
