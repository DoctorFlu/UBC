import type { CSSProperties, ReactNode } from "react";

import { cx } from "@/lib/cx";
import { formatPercentBps, formatUsdCents, shareBps } from "@/lib/format";

import styles from "./LimitMeter.module.css";

export interface LimitMeterProps {
  label: ReactNode;
  /** Load against the rule, in cents. */
  usedCents: number;
  /** The rule's limit (its rating), in cents. */
  limitCents: number;
  /** Words for the used figure, e.g. "used" or "largest order". */
  usedWord?: string;
  /** Hide the foot line (percent and headroom); for the compact sidebar schedule. */
  compact?: boolean;
  className?: string;
}

export const WARN_AT_BPS = 8_000;

export function meterTone(bps: number): "ok" | "warn" | "over" {
  if (bps >= 10_000) return "over";
  if (bps >= WARN_AT_BPS) return "warn";
  return "ok";
}

/** One rule of the mandate as a rated circuit: its load on a graduated rail. */
export function LimitMeter({
  label,
  usedCents,
  limitCents,
  usedWord = "used",
  compact = false,
  className,
}: LimitMeterProps) {
  const bps = shareBps(usedCents, limitCents);
  const tone = meterTone(bps);
  const load = `${Math.min(100, bps / 100).toString()}%`;
  const reading = `${formatUsdCents(usedCents)} of ${formatUsdCents(limitCents)}`;
  const headroom = Math.max(0, limitCents - usedCents);
  return (
    <div className={cx(styles.meter, styles[tone], compact && styles.compact, className)}>
      <span className={styles.label}>{label}</span>
      <span className={styles.reading}>
        <strong>{formatUsdCents(usedCents)}</strong> of {formatUsdCents(limitCents)}
      </span>
      <div
        className={styles.rail}
        role="meter"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={limitCents}
        aria-valuenow={Math.min(usedCents, limitCents)}
        aria-valuetext={`${reading} ${usedWord}`}
        style={{ "--load": load } as CSSProperties}
      >
        <div className={styles.track}>
          <div className={styles.fill} />
        </div>
        <div className={styles.ticks} aria-hidden />
      </div>
      {compact ? null : (
        <div className={styles.foot}>
          <span className={styles.state}>
            {formatPercentBps(bps, { fractionDigits: 0 })} {usedWord}
            {tone === "warn" ? ", nearly reached" : tone === "over" ? ", reached" : ""}
          </span>
          <span>{formatUsdCents(headroom)} left</span>
        </div>
      )}
    </div>
  );
}
