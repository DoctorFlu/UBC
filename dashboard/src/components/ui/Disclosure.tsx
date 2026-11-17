"use client";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { useAdvanced } from "@/lib/advanced/Advanced";
import { cx } from "@/lib/cx";

import styles from "./Disclosure.module.css";

export interface DisclosureProps {
  /** What is inside, as a heading: "Payoff and live quotes". */
  title: string;
  /** One line that says what the closed section holds, so the owner knows whether to open it. */
  summary: ReactNode;
  children: ReactNode;
  /** Heading level of the title, to keep the outline correct. Defaults to h2. */
  headingLevel?: 2 | 3;
  className?: string;
  "data-testid"?: string;
}

/**
 * A section the default view keeps closed and Advanced view opens: a heading whose button shows and
 * hides the content (ui-sdk's Collapsible, so `aria-expanded`, Enter and Space come with it), and one
 * line of summary under it while closed. Switching Advanced view on or off opens or closes it again.
 */
export function Disclosure({
  title,
  summary,
  children,
  headingLevel = 2,
  className,
  "data-testid": testId,
}: DisclosureProps) {
  const { advanced } = useAdvanced();
  const [open, setOpen] = useState(advanced);
  const [followed, setFollowed] = useState(advanced);
  if (followed !== advanced) {
    setFollowed(advanced);
    setOpen(advanced);
  }
  const summaryId = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cx(styles.disclosure, className)}
      data-testid={testId}
    >
      <div className={styles.bar}>
        <Heading className={styles.heading}>
          <CollapsibleTrigger className={styles.trigger} aria-describedby={open ? undefined : summaryId}>
            <ChevronRight aria-hidden className={styles.chevron} nonScalingStroke strokeWidth={2} />
            <span className={styles.title}>{title}</span>
          </CollapsibleTrigger>
        </Heading>
        {open ? null : (
          <p id={summaryId} className={styles.summary}>
            {summary}
          </p>
        )}
      </div>
      <CollapsiblePanel className={styles.panel}>{children}</CollapsiblePanel>
    </Collapsible>
  );
}
