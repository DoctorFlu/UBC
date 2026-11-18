"use client";

import { Box, CircleHelp, Drama, Zap } from "lucide-react";
import { useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { SandboxLiquidity } from "@/lib/live/types";
import { type FillSource, contractFillSource } from "@/lib/network";

import styles from "./Shell.module.css";

/** `prefix` is read to screen readers only, before the text: "Gemini Sandbox". */
const BADGES: Record<
  FillSource,
  { text: string; prefix: string; title: string; className: string; Icon: typeof Box }
> = {
  live: {
    text: "Live",
    prefix: "Gemini ",
    title: "Gemini, with real money",
    className: styles.venueBadgeLive ?? "",
    Icon: Zap,
  },
  sandbox: {
    text: "Sandbox",
    prefix: "Gemini ",
    title: "Gemini's sandbox",
    className: "",
    Icon: Box,
  },
  simulated: {
    text: "Simulated fills",
    prefix: "",
    title: "Simulated fills",
    className: styles.venueBadgeSimulated ?? "",
    Icon: Drama,
  },
  unknown: {
    text: "Fill source unknown",
    prefix: "",
    title: "Fill source unknown",
    className: styles.venueBadgeUnknown ?? "",
    Icon: CircleHelp,
  },
};

/**
 * What the badge's details say, sentence by sentence. Every sentence is either what the executor announced
 * (the venue) or what the operator declared (`SANDBOX_LIQUIDITY`); the console infers neither.
 */
export function venueDetails(source: FillSource, liquidity: SandboxLiquidity | null): string[] {
  switch (source) {
    case "live":
      return ["The executor places approved orders on Gemini with real money."];
    case "sandbox":
      return [
        "The executor places approved orders on Gemini's sandbox, with test funds only.",
        ...(liquidity === "mirror-maker"
          ? [
              "Prices come from Gemini's live exchange: our own market maker, on a second sandbox account, quotes the sandbox at those prices on the ladders it covers.",
            ]
          : []),
        "Gemini settles every contract on the real BTC index.",
      ];
    case "simulated":
      return [
        "The executor's simulated venue fills approved orders.",
        "They are recorded onchain, but no exchange sees them.",
      ];
    case "unknown":
      return [
        "The executor has not said which venue fills this contract's orders, so the console can't say whether an exchange sees them.",
      ];
  }
}

/**
 * Where approved orders are filled (issue #93), from the venue the executor announced for this contract,
 * never from the chain: "Live" for real money on Gemini, "Sandbox" for its test funds, "Simulated fills"
 * for the simulated venue (also on Arc), and "Fill source unknown" until the executor says. `short` is the
 * phone form: the icon alone, with the words for screen readers. Pressing it, by pointer, touch or keyboard,
 * opens the details.
 */
export function VenueBadge({ short = false }: { short?: boolean }) {
  const snapshot = useSnapshot();
  const [open, setOpen] = useState(false);
  const chain = snapshot.chain;
  if (!chain) return null;
  const source = contractFillSource(chain, snapshot.network);
  const badge = BADGES[source];
  const { Icon } = badge;
  return (
    <>
      <button
        type="button"
        className={[styles.venueBadge, badge.className, short ? styles.venueBadgeShort : ""]
          .filter(Boolean)
          .join(" ")}
        aria-label={`${badge.prefix}${badge.text}, venue details`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        data-testid="venue-badge"
        data-venue={source}
      >
        <Icon aria-hidden strokeWidth={2} />
        {short ? (
          <span className="visually-hidden">{`${badge.prefix}${badge.text}`}</span>
        ) : (
          <>
            {badge.prefix ? <span className="visually-hidden">{badge.prefix}</span> : null}
            {badge.text}
          </>
        )}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Orders: ${badge.title}`}
        description="Where the executor fills this contract's approved orders."
        variant="sheet"
      >
        <div className={styles.venueDetails} data-testid="venue-details">
          {venueDetails(source, snapshot.sandboxLiquidity).map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
      </Dialog>
    </>
  );
}
