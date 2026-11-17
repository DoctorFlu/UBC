"use client";

import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from "react";

import { cx } from "@/lib/cx";

import styles from "./ClampedText.module.css";

export interface ClampedTextProps {
  text: string;
  /** Lines shown until the reader asks for the rest. */
  lines?: number;
  className?: string;
  "data-testid"?: string;
}

/**
 * Text of any length cut to a few lines, with "Show more" only when it does not fit (measured, so a
 * short text never gets one). The toggle sits over the end of the last line until it is pressed, so it
 * appearing after hydration moves nothing; long words wrap anywhere.
 */
export function ClampedText({ text, lines = 3, className, "data-testid": testId }: ClampedTextProps) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || expanded) return undefined;
    let live = true;
    const measure = () => {
      if (live) setOverflows(element.scrollHeight - element.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // A late web font can push the text past the clamp without changing the clamped box's size.
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [expanded, text, lines]);

  return (
    <div
      className={cx(styles.clamp, className)}
      data-expanded={expanded || undefined}
      data-testid={testId}
      style={{ "--clamp-lines": lines } as CSSProperties}
    >
      <p ref={ref} id={id} className={styles.text}>
        {text}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
