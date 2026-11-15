"use client";

import { CircleAlert, Power, RefreshCw } from "lucide-react";

import { useLiveConsole } from "@/lib/live/LiveConsole";

import styles from "./Shell.module.css";

/** Shown on every console screen while the mandate is paused, as the contract's last `Paused` event says. */
export function PausedBanner() {
  const { snapshot } = useLiveConsole();
  const paused = snapshot.chain?.paused ?? false;
  return (
    <div aria-live="polite">
      {paused ? (
        <div className={styles.paused} data-testid="paused-banner">
          <span className={styles.pausedMarker} aria-hidden>
            <Power strokeWidth={2.25} />
          </span>
          <p className={styles.pausedText}>
            <strong>Agent paused.</strong> The Policy contract rejects every new intent until you resume.
            Intents waiting for you stay waiting.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Says why the data may be stale or missing, on every screen: the console lost its own event stream,
 * the chain is unreachable, no contract is configured yet, or history is still being read.
 */
export function FeedNotice() {
  const { snapshot, connection } = useLiveConsole();
  const { feed } = snapshot;
  let notice: { tone: "offline" | "waiting"; text: string; icon: "alert" | "sync" } | null = null;
  if (connection === "reconnecting") {
    notice = {
      tone: "offline",
      icon: "alert",
      text: "Lost the connection to the console server. Reconnecting; what you see may be out of date.",
    };
  } else if (feed.health === "offline" || feed.health === "unconfigured") {
    notice = { tone: feed.health === "offline" ? "offline" : "waiting", icon: "alert", text: feed.detail };
  } else if (feed.health === "starting" || feed.health === "lagging") {
    notice = { tone: "waiting", icon: "sync", text: feed.detail };
  }
  return (
    <div aria-live="polite">
      {notice ? (
        <p className={styles.feedNotice} data-tone={notice.tone} data-testid="feed-notice">
          {notice.icon === "alert" ? <CircleAlert aria-hidden /> : <RefreshCw aria-hidden />}
          <span>{notice.text}</span>
        </p>
      ) : null}
    </div>
  );
}
