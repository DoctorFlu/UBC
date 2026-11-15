import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Stat.module.css";

export interface StatDelta {
  /** Already formatted, e.g. "+$12.50" or "+3". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether this direction is good news. A rising loss is "bad" even though it goes up. */
  sentiment: "good" | "bad" | "neutral";
  /** What the change is measured against, e.g. "since 09:00 UTC". */
  period?: string;
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
  size?: "md" | "sm";
  className?: string;
}

const directionIcon = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus };
const directionWord = { up: "up", down: "down", flat: "unchanged" };

/** A labelled figure with an optional change. Pass already-formatted money from lib/format. */
export function Stat({ label, value, delta, hint, size = "md", className }: StatProps) {
  const Icon = delta ? directionIcon[delta.direction] : null;
  return (
    <div className={cx(styles.stat, size === "sm" && styles.sm, className)}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{value}</dd>
      {delta || hint ? (
        <dd className={styles.foot}>
          {delta && Icon ? (
            <span className={cx(styles.delta, styles[delta.sentiment])}>
              <Icon aria-hidden strokeWidth={2.25} />
              <span className="visually-hidden">{directionWord[delta.direction]} </span>
              {delta.value}
            </span>
          ) : null}
          {delta?.period ? <span>{delta.period}</span> : null}
          {hint ? <span>{hint}</span> : null}
        </dd>
      ) : null}
    </div>
  );
}

/** Wraps a row of Stat items in the description list they belong to. */
export function StatGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cx(styles.group, className)}>{children}</dl>;
}
