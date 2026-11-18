"use client";

import { CircleAlert, Power, RefreshCw, Wallet } from "lucide-react";

import { useLiveConsole } from "@/lib/live/LiveConsole";
import { useOwnerAccess } from "@/lib/owner/access";
import { useWalletState } from "@/lib/wallet/useWalletState";

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

/**
 * Says in the page, not only in a disabled button's tooltip, why no owner control works while the owner's
 * wallet is on another network or did not answer, and what one step fixes it.
 */
export function WalletNotice() {
  const access = useOwnerAccess();
  const wallet = useWalletState();
  const { snapshot } = useLiveConsole();
  return (
    <div aria-live="polite">
      {access.kind === "disconnected" && wallet.kind === "disconnected" && wallet.unanswered ? (
        <p className={styles.feedNotice} data-tone="waiting" data-testid="wallet-notice">
          <Wallet aria-hidden />
          <span>
            {wallet.unanswered} did not answer. Open it to unlock, then press &ldquo;Connect wallet&rdquo;.
          </span>
        </p>
      ) : access.kind === "wrong-network" ? (
        <p className={styles.feedNotice} data-tone="waiting" data-testid="wallet-notice">
          <Wallet aria-hidden />
          <span>
            Your wallet is on another network, so approving, rejecting, changing the rules and pausing are off
            until it is on {snapshot.network.name}. Press &ldquo;Switch to {snapshot.network.name}&rdquo; at
            the top; your wallet asks to add the network first if it does not know it. Nothing is sent until
            then.
          </span>
        </p>
      ) : access.kind === "not-owner" ? (
        <p className={styles.feedNotice} data-tone="waiting" data-testid="wallet-notice">
          <Wallet aria-hidden />
          <span>{access.reason} Approving, rejecting, changing the rules and pausing are off for now.</span>
        </p>
      ) : null}
    </div>
  );
}
