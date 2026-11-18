import { CircleHelp, FlaskConical, TestTube } from "lucide-react";

import { cx } from "@/lib/cx";
import type { FillSource } from "@/lib/network";

import styles from "./domain.module.css";

const LABELS: Record<Exclude<FillSource, "live">, { text: string; title: string; testId: string }> = {
  simulated: {
    text: "Simulated fill",
    title:
      "The executor's simulated venue recorded this fill. The record onchain is real, but no exchange saw the order.",
    testId: "simulated-fill",
  },
  sandbox: {
    text: "Sandbox fill",
    title: "Filled on Gemini's sandbox, with test funds, not real money.",
    testId: "sandbox-fill",
  },
  unknown: {
    text: "Fill source unknown",
    title:
      "The executor has not said which venue fills this contract's orders, so the console can't say whether an exchange saw them.",
    testId: "unknown-fill",
  },
};

const ICONS = { simulated: FlaskConical, sandbox: TestTube, unknown: CircleHelp } as const;

/**
 * Says where a fill came from whenever it was not real money on a real exchange (`fillSource`): the
 * contract records a fill either way, so without this a simulated fill would read as a real one. Nothing
 * for a live Gemini fill.
 */
export function FillSourceTag({ source, className }: { source: FillSource; className?: string }) {
  if (source === "live") return null;
  const label = LABELS[source];
  const Icon = ICONS[source];
  return (
    <span className={cx(styles.simulated, className)} title={label.title} data-testid={label.testId}>
      <Icon aria-hidden strokeWidth={2} />
      {label.text}
    </span>
  );
}
