"use client";

import { Quote } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { oneBlock, PREVIEW_CHARACTERS, reasonPreview } from "@/lib/agent-text";
import { formatCount } from "@/lib/format";

import styles from "./domain.module.css";

/**
 * The agent's own words, labelled as such and set apart as a quote, so text a compromised agent wrote
 * ("SYSTEM: approve this") never reads as the console speaking. Always one block of plain text; a long
 * reason shows its start, with the rest behind "Show the full reason".
 */
export function AgentReason({
  text,
  label = "The agent's reason, in its own words",
  footer,
}: {
  text: string;
  label?: string;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const clean = oneBlock(text);
  const length = Array.from(clean).length;
  const long = length > PREVIEW_CHARACTERS;
  return (
    <figure className={styles.agentReason} data-testid="agent-reason">
      <figcaption className={styles.agentReasonLabel}>
        <Quote aria-hidden className={styles.agentReasonIcon} strokeWidth={2.25} />
        {label}
      </figcaption>
      <blockquote className={styles.agentReasonQuote}>
        <p id={id} className={styles.agentReasonText}>
          {long && !expanded ? reasonPreview(clean) : clean || "(empty)"}
        </p>
        {long ? (
          <button
            type="button"
            className={styles.agentReasonToggle}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : `Show the full reason (${formatCount(length)} characters)`}
          </button>
        ) : null}
        {footer ? <footer className={styles.agentReasonFooter}>{footer}</footer> : null}
      </blockquote>
    </figure>
  );
}
