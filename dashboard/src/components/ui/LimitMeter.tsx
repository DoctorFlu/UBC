import type { CSSProperties, ReactNode } from "react";

import { cx } from "@/lib/cx";
import { formatPercentBps, formatUsdCents } from "@/lib/format";
import { formatUsdc } from "@/lib/payments/usdc";

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
export function LimitMeter({ usedCents, limitCents, ...rest }: LimitMeterProps) {
  return (
    <Meter
      {...rest}
      used={BigInt(usedCents)}
      limit={BigInt(limitCents)}
      format={(value) => formatUsdCents(value)}
    />
  );
}

export interface UsdcMeterProps extends Omit<LimitMeterProps, "usedCents" | "limitCents"> {
  /** USDC atomic units (6 decimals). */
  used: bigint;
  limit: bigint;
}

/** The same rail for a USDC budget in atomic units, formatted exactly. */
export function UsdcMeter({ used, limit, ...rest }: UsdcMeterProps) {
  return <Meter {...rest} used={used} limit={limit} format={(value) => formatUsdc(value)} />;
}

function Meter({
  label,
  used,
  limit,
  format,
  usedWord = "used",
  compact = false,
  className,
}: Omit<LimitMeterProps, "usedCents" | "limitCents"> & {
  used: bigint;
  limit: bigint;
  format: (value: bigint) => string;
}) {
  const bps = limit <= 0n ? 0 : Number((used * 10_000n) / limit);
  const tone = meterTone(bps);
  const load = `${Math.min(100, bps / 100).toString()}%`;
  const reading = `${format(used)} of ${format(limit)}`;
  const headroom = limit > used ? limit - used : 0n;
  return (
    <div className={cx(styles.meter, styles[tone], compact && styles.compact, className)}>
      <span className={styles.label}>{label}</span>
      <span className={styles.reading}>
        <strong>{format(used)}</strong> of {format(limit)}
      </span>
      <div
        className={styles.rail}
        role="meter"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={Number(limit)}
        aria-valuenow={Number(used < limit ? used : limit)}
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
          <span>{format(headroom)} left</span>
        </div>
      )}
    </div>
  );
}
