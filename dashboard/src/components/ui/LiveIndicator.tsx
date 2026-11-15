import type { FeedHealth, FeedSource } from "@/lib/live/types";
import { cx } from "@/lib/cx";
import { formatTimeUtc } from "@/lib/format";

import styles from "./LiveIndicator.module.css";

const sourceNames: Record<FeedSource, string> = { rpc: "RPC poller", stream: "QuickNode Stream" };

const healthWords: Record<FeedHealth | "disconnected", string> = {
  live: "Live",
  starting: "Syncing",
  lagging: "Lagging",
  offline: "Offline",
  unconfigured: "No contract",
  disconnected: "Reconnecting",
};

export interface LiveIndicatorProps {
  source: FeedSource;
  /** The feed's health, or "disconnected" when the browser lost the console's event stream. */
  health: FeedHealth | "disconnected";
  /** One sentence on what the feed is doing, for the tooltip and screen readers. */
  detail: string;
  /** ISO time of the newest event. */
  lastEventAt?: string | null | undefined;
  /** Hide the source name, keep the lamp and the word (phone top bar). */
  compact?: boolean;
  className?: string;
}

/** Where the console's events come from right now (the Stream webhook or the RPC poller) and whether it is healthy. */
export function LiveIndicator({
  source,
  health,
  detail,
  lastEventAt,
  compact = false,
  className,
}: LiveIndicatorProps) {
  const sourceName = sourceNames[source];
  const title = [detail, lastEventAt ? `Last event ${formatTimeUtc(lastEventAt)}.` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={cx(styles.indicator, styles[health], compact && styles.compact, className)}
      title={title}
      data-testid="live-indicator"
      data-source={source}
      data-health={health}
    >
      <span className={styles.lamp} aria-hidden />
      <span>{healthWords[health]}</span>
      <span className={styles.detail}>{sourceName}</span>
      <span className="visually-hidden">. {detail}</span>
    </span>
  );
}
