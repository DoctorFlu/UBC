"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

import { HexValue } from "@/components/ui/HexValue";
import { cx } from "@/lib/cx";
import type { OwnerTxState } from "@/lib/owner/useOwnerTx";

import styles from "./OwnerTxStatus.module.css";

const phaseText: Record<Exclude<OwnerTxState["phase"], "idle" | "failed" | "done">, string> = {
  checking: "Checking it with the Policy contract.",
  signing: "Confirm it in your wallet.",
  pending: "Sent. Waiting for it to be mined.",
  syncing: "Mined. Waiting for the console to read the event.",
};

/** Where an owner transaction is: checking, in the wallet, mined, seen by the console, or failed, with its hash. */
export function OwnerTxStatus({ state, className }: { state: OwnerTxState; className?: string }) {
  if (state.phase === "idle")
    return <div className={cx(styles.status, className)} role="status" aria-live="polite" />;
  const hash = "hash" in state ? state.hash : null;
  let tone: "busy" | "done" | "failed";
  let text: string;
  if (state.phase === "failed") {
    tone = "failed";
    text = state.message;
  } else if (state.phase === "done") {
    tone = "done";
    text = state.synced
      ? "Done. Every view now shows it."
      : "Mined. The console has not read the event yet; views update when it does.";
  } else {
    tone = "busy";
    text = phaseText[state.phase];
  }
  const Icon = tone === "busy" ? LoaderCircle : tone === "done" ? CircleCheck : CircleAlert;
  return (
    <div
      className={cx(styles.status, styles[tone], className)}
      role="status"
      aria-live="polite"
      data-testid="owner-tx-status"
      data-phase={state.phase}
    >
      <Icon className={styles.icon} aria-hidden strokeWidth={2} />
      <span className={styles.text}>
        <span className={styles.label}>{state.label}.</span> {text}
      </span>
      {hash ? <HexValue className={styles.hash} label="Tx" value={hash} kind="tx" /> : null}
    </div>
  );
}
