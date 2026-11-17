import { FlaskConical, Zap } from "lucide-react";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { venueBadge } from "@/lib/network";

import styles from "./Shell.module.css";

/**
 * Where approved orders are really placed (issue #93), as the executor last announced it: "Sandbox" for
 * Gemini's test funds, "Live" for real money. Nothing for the simulated executor, which places nothing.
 */
export function VenueBadge() {
  const snapshot = useSnapshot();
  const badge = venueBadge(snapshot.chain?.venue ?? null);
  if (badge === null) return null;
  const live = badge === "Live";
  return (
    <span
      className={live ? `${styles.venueBadge} ${styles.venueBadgeLive}` : styles.venueBadge}
      title={
        live
          ? "The executor places approved orders on Gemini with real money."
          : "The executor places approved orders on Gemini's sandbox, with test funds only."
      }
      data-testid="venue-badge"
      data-venue={live ? "live" : "sandbox"}
    >
      {live ? <Zap aria-hidden strokeWidth={2} /> : <FlaskConical aria-hidden strokeWidth={2} />}
      <span className="visually-hidden">Gemini </span>
      {badge}
    </span>
  );
}
