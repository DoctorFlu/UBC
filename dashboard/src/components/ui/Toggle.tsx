"use client";

import { type ReactNode, useId } from "react";

import { cx } from "@/lib/cx";

import styles from "./Toggle.module.css";

export interface ToggleProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch: a native checkbox with role="switch", so it keeps form semantics, Space to
 * toggle, and the right announcement. Use it for settings that apply at once, not for form fields.
 */
export function Toggle({ label, description, checked, onChange, disabled = false, className }: ToggleProps) {
  const id = useId();
  const descriptionId = description !== undefined ? `${id}-description` : undefined;
  return (
    <label className={cx(styles.toggle, className)} htmlFor={id} data-disabled={disabled || undefined}>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description !== undefined ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
