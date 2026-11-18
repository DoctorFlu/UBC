import { Box, CircleHelp, Drama, Zap } from "lucide-react";

import { useSnapshot } from "@/lib/live/LiveConsole";
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
    title: "Live: the executor places approved orders on Gemini with real money.",
    className: styles.venueBadgeLive ?? "",
    Icon: Zap,
  },
  sandbox: {
    text: "Sandbox",
    prefix: "Gemini ",
    title: "Sandbox: the executor places approved orders on Gemini's sandbox, with test funds only.",
    className: "",
    Icon: Box,
  },
  simulated: {
    text: "Simulated fills",
    prefix: "",
    title:
      "Simulated fills: the executor's simulated venue fills approved orders. They are recorded onchain, but no exchange sees them.",
    className: styles.venueBadgeSimulated ?? "",
    Icon: Drama,
  },
  unknown: {
    text: "Fill source unknown",
    prefix: "",
    title:
      "The executor has not said which venue fills this contract's orders, so the console can't say whether an exchange sees them.",
    className: styles.venueBadgeUnknown ?? "",
    Icon: CircleHelp,
  },
};

/**
 * Where approved orders are filled (issue #93), from the venue the executor announced for this contract,
 * never from the chain: "Live" for real money on Gemini, "Sandbox" for its test funds, "Simulated fills"
 * for the simulated venue (also on Arc), and "Fill source unknown" until the executor says. `short` is the
 * phone form: the icon alone, with the words for screen readers.
 */
export function VenueBadge({ short = false }: { short?: boolean }) {
  const snapshot = useSnapshot();
  const chain = snapshot.chain;
  if (!chain) return null;
  const source = contractFillSource(chain, snapshot.network);
  const badge = BADGES[source];
  const { Icon } = badge;
  return (
    <span
      className={[styles.venueBadge, badge.className, short ? styles.venueBadgeShort : ""]
        .filter(Boolean)
        .join(" ")}
      title={badge.title}
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
    </span>
  );
}
