import type { LiveSource } from "@/lib/domain";
import { cx } from "@/lib/cx";
import { formatTimeUtc } from "@/lib/format";

import styles from "./LiveIndicator.module.css";

const sourceLabels: Record<LiveSource, { label: string; detail: string }> = {
  stream: { label: "Live", detail: "QuickNode Stream" },
  poller: { label: "Live", detail: "RPC poller" },
  offline: { label: "Offline", detail: "No event source" },
};

export interface LiveIndicatorProps {
  source: LiveSource;
  /** ISO time of the newest event, shown in the tooltip. */
  lastEventAt?: string | undefined;
  /** Hide the source name, keep the lamp and the word (phone top bar). */
  compact?: boolean;
  className?: string;
}

/** Which data source is feeding the console right now: the Stream webhook, the RPC poller, or nothing. */
export function LiveIndicator({ source, lastEventAt, compact = false, className }: LiveIndicatorProps) {
  const { label, detail } = sourceLabels[source];
  const title = lastEventAt ? `${detail}. Last event ${formatTimeUtc(lastEventAt)}.` : `${detail}.`;
  return (
    <span
      className={cx(styles.live, styles[source], compact && styles.compact, className)}
      title={title}
      data-source={source}
    >
      <span className={styles.lamp} aria-hidden />
      <span>{label}</span>
      <span className={styles.detail}>{detail}</span>
      {compact ? <span className="visually-hidden">, {detail}</span> : null}
    </span>
  );
}
