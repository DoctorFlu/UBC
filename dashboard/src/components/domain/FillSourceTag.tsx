import { CircleHelp, Drama, Landmark, TestTube } from "lucide-react";

import { cx } from "@/lib/cx";
import type { FillShare, FillSource } from "@/lib/network";
import { formatCount } from "@/lib/format";

import styles from "./domain.module.css";

const LABELS: Record<FillSource, { text: string; share: string; title: string; testId: string }> = {
  simulated: {
    text: "Simulated fill",
    share: "simulated",
    title:
      "The executor's simulated venue recorded this fill. The record onchain is real, but no exchange saw the order.",
    testId: "simulated-fill",
  },
  sandbox: {
    text: "Sandbox fill",
    share: "on the sandbox",
    // Only what the executor's journal proves; who took the other side is not a fact the console has.
    title: "Filled on Gemini's sandbox, with test funds.",
    testId: "sandbox-fill",
  },
  unknown: {
    text: "Fill source unknown",
    share: "source unknown",
    title:
      "The executor had not said which venue fills this contract's orders, so the console can't say whether an exchange saw them.",
    testId: "unknown-fill",
  },
  live: {
    text: "Live fill",
    share: "on Gemini",
    title: "Filled on Gemini, with real money.",
    testId: "live-fill",
  },
};

const ICONS = { simulated: Drama, sandbox: TestTube, unknown: CircleHelp, live: Landmark } as const;

/**
 * Says where a fill came from whenever it was not real money on a real exchange (`fillSource`): the
 * contract records a fill either way, so without this a simulated fill would read as a real one. Nothing
 * for a live Gemini fill, unless `count` gives it a share of a mixed total.
 */
export function FillSourceTag({
  source,
  count,
  className,
}: {
  source: FillSource;
  /** Part of a mixed total: "8 simulated". */
  count?: number;
  className?: string;
}) {
  if (source === "live" && count === undefined) return null;
  const label = LABELS[source];
  const Icon = ICONS[source];
  return (
    <span
      className={cx(styles.simulated, source === "live" && styles.liveShare, className)}
      title={label.title}
      data-testid={label.testId}
      data-count={count}
    >
      <Icon aria-hidden strokeWidth={2} />
      {count === undefined ? label.text : `${formatCount(count)} ${label.share}`}
    </span>
  );
}

/**
 * Where a total's fills came from (`fillShares`): the one tag when they share a source, as on a single
 * fill, and each source's count when they differ ("8 simulated", "1 on the sandbox"), so a total of
 * mixed fills never reads as one kind.
 */
export function FillSharesTag({ shares }: { shares: readonly FillShare[] }) {
  const [only, ...more] = shares;
  if (!only) return null;
  if (more.length === 0) return <FillSourceTag source={only.source} />;
  return (
    <span className={styles.fillShares} data-testid="fill-shares">
      <span className="visually-hidden">Fills by source: </span>
      {shares.map((share) => (
        <FillSourceTag key={share.source} source={share.source} count={share.count} />
      ))}
    </span>
  );
}
