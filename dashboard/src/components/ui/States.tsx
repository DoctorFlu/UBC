import { TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./States.module.css";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  /** Say what will appear here and what makes it appear. */
  children?: ReactNode;
  action?: ReactNode;
  /** No frame, for use inside a card. */
  plain?: boolean;
  className?: string;
}

/** An empty view is an invitation to act: say what will show up here and how to get it. */
export function EmptyState({ icon, title, children, action, plain = false, className }: EmptyStateProps) {
  return (
    <div className={cx(styles.state, plain && styles.plain, className)}>
      {icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
      {action ? <div className={styles.actions}>{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: ReactNode;
  /** What went wrong and how to recover, in plain words. */
  children?: ReactNode;
  /** A machine detail for bug reports, e.g. an error digest. */
  detail?: string | undefined;
  action?: ReactNode;
  className?: string;
}

/** Errors name the problem and the recovery. They do not apologize. */
export function ErrorState({ title, children, detail, action, className }: ErrorStateProps) {
  return (
    <div className={cx(styles.state, styles.error, className)} role="alert">
      <span className={styles.icon} aria-hidden>
        <TriangleAlert strokeWidth={2} />
      </span>
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {action ? <div className={styles.actions}>{action}</div> : null}
    </div>
  );
}

export interface SkeletonProps {
  width?: string;
  height?: string;
  radius?: string;
  className?: string;
}

/** A placeholder the exact size of the content it stands in for. */
export function Skeleton({ width = "100%", height = "1rem", radius, className }: SkeletonProps) {
  const style: CSSProperties = { width, height, ...(radius ? { borderRadius: radius } : {}) };
  return <span className={cx(styles.skeleton, className)} style={style} aria-hidden />;
}

/** Several lines of text, the last one shorter. */
export function SkeletonText({
  lines = 3,
  lineHeight = "0.875rem",
}: {
  lines?: number;
  lineHeight?: string;
}) {
  return (
    <span className={styles.lines} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={lineHeight} width={index === lines - 1 ? "62%" : "100%"} />
      ))}
    </span>
  );
}
