import { type ReactNode, useId } from "react";

import { cx } from "@/lib/cx";

import styles from "./Card.module.css";

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls in the header, aligned right. */
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** "flush" drops the body padding so a table can run edge to edge. */
  padding?: "default" | "flush";
  tone?: "default" | "sunken" | "attention";
  /** Heading level of the title, to keep the outline correct. Defaults to h2. */
  headingLevel?: 2 | 3;
  className?: string;
  id?: string;
}

/** A section of the board. Not for every group of content: use it when the group has its own title. */
export function Card({
  title,
  description,
  actions,
  footer,
  children,
  padding = "default",
  tone = "default",
  headingLevel = 2,
  className,
  id,
}: CardProps) {
  const titleId = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section
      id={id}
      className={cx(styles.card, tone !== "default" && styles[tone], className)}
      aria-labelledby={title !== undefined ? titleId : undefined}
    >
      {hasHeader ? (
        <header className={styles.header}>
          <div className={styles.headings}>
            {title !== undefined ? (
              <Heading id={titleId} className={styles.title}>
                {title}
              </Heading>
            ) : null}
            {description !== undefined ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className={cx(styles.body, padding === "flush" && styles.flush)}>{children}</div>
      ) : null}
      {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  );
}
