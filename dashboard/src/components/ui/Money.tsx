import { cx } from "@/lib/cx";
import { type MoneyOptions, type PercentOptions, formatPercentBps, formatUsdCents } from "@/lib/format";

export interface MoneyProps extends MoneyOptions {
  /** Integer cents. */
  cents: number | bigint;
  className?: string;
}

/** Money as tabular figures. Integer cents in, exact string out. */
export function Money({ cents, className, ...options }: MoneyProps) {
  return <span className={cx("num", className)}>{formatUsdCents(cents, options)}</span>;
}

export interface PercentProps extends PercentOptions {
  /** Basis points: 1250 is 12.50%. */
  bps: number | bigint;
  className?: string;
}

export function Percent({ bps, className, ...options }: PercentProps) {
  return <span className={cx("num", className)}>{formatPercentBps(bps, options)}</span>;
}
