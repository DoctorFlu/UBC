"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { cx } from "@/lib/cx";

import styles from "./CopyButton.module.css";

/** Class for an icon-sized link that sits beside a copy button. */
export const iconButtonClass = styles.iconButton;

export interface CopyButtonProps {
  /** The exact text put on the clipboard. */
  value: string;
  /** What is copied, for the accessible name: "Copy address", "Copied address". */
  what: string;
  className?: string;
}

/** Copies a value and confirms it with an icon swap and a polite status message. */
export function CopyButton({ value, what, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the value stays selectable.
      setCopied(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={cx(styles.iconButton, className)}
        onClick={onCopy}
        data-copied={copied || undefined}
        aria-label={copied ? `Copied ${what}` : `Copy ${what}`}
      >
        <Copy className={styles.copy} aria-hidden strokeWidth={1.75} />
        <Check className={styles.copied} aria-hidden strokeWidth={2.25} />
      </button>
      <span className="visually-hidden" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
