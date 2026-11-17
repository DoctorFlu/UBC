import { Box, Zap } from "lucide-react";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { venueBadge } from "@/lib/network";

import styles from "./Shell.module.css";

/**
 * Where approved orders are really placed (issue #93), as the executor last announced it: "Sandbox" for
 * Gemini's test funds, "Live" for real money. Nothing for the simulated executor, which places nothing.
 * `short` is the phone form: the icon alone (a box for the sandbox, a bolt for real money), with the
 * words for screen readers, so the strip still fits beside the lamp, Dev and the isolator.
 */
export function VenueBadge({ short = false }: { short?: boolean }) {
  const snapshot = useSnapshot();
  const badge = venueBadge(snapshot.chain?.venue ?? null);
  if (badge === null) return null;
  const live = badge === "Live";
  return (
    <span
      className={[styles.venueBadge, live ? styles.venueBadgeLive : "", short ? styles.venueBadgeShort : ""]
        .filter(Boolean)
        .join(" ")}
      title={
        live
          ? "Live: the executor places approved orders on Gemini with real money."
          : "Sandbox: the executor places approved orders on Gemini's sandbox, with test funds only."
      }
      data-testid="venue-badge"
      data-venue={live ? "live" : "sandbox"}
    >
      {live ? <Zap aria-hidden strokeWidth={2} /> : <Box aria-hidden strokeWidth={2} />}
      {short ? (
        <span className="visually-hidden">Gemini {badge}</span>
      ) : (
        <>
          <span className="visually-hidden">Gemini </span>
          {badge}
        </>
      )}
    </span>
  );
}
