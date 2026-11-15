"use client";

import { Power } from "lucide-react";

import { useConsoleState } from "./ConsoleState";
import styles from "./Shell.module.css";

/** Shown on every console screen while the mandate is paused. */
export function PausedBanner() {
  const { paused } = useConsoleState();
  return (
    <div aria-live="polite">
      {paused ? (
        <div className={styles.paused} data-testid="paused-banner">
          <span className={styles.pausedMarker} aria-hidden>
            <Power strokeWidth={2.25} />
          </span>
          <p className={styles.pausedText}>
            <strong>Agent paused.</strong> The Policy contract rejects every new intent until you resume. Held
            intents stay held.
          </p>
        </div>
      ) : null}
    </div>
  );
}
