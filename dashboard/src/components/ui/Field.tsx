"use client";

import { CircleAlert } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from "react";

import { cx } from "@/lib/cx";

import styles from "./Field.module.css";

export interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** A message saying what is wrong and how to fix it. Marks the control invalid. */
  error?: ReactNode;
  optional?: boolean;
  /** Receives the id and ARIA wiring for the control. */
  children: (control: ControlProps) => ReactNode;
  className?: string;
}

/** Label, hint and error around any control, wired for assistive technology. */
export function Field({ label, hint, error, optional = false, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error !== undefined ? true : undefined,
      })}
      {error !== undefined ? (
        <p id={errorId} className={styles.error}>
          <CircleAlert aria-hidden strokeWidth={2.25} />
          <span>{error}</span>
        </p>
      ) : null}
      {hint !== undefined ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Text before the value, e.g. "$". */
  prefix?: string;
  /** Text after the value, e.g. "USDC". */
  suffix?: string;
}

export function Input({ prefix, suffix, className, disabled, ...rest }: InputProps) {
  return (
    <span
      className={cx(styles.control, className)}
      data-invalid={rest["aria-invalid"] === true || undefined}
      data-disabled={disabled === true || undefined}
    >
      {prefix ? (
        <span className={styles.affix} aria-hidden>
          {prefix}
        </span>
      ) : null}
      <input className={styles.input} disabled={disabled} {...rest} />
      {suffix ? (
        <span className={styles.suffix} aria-hidden>
          {suffix}
        </span>
      ) : null}
    </span>
  );
}

export function Select({ className, disabled, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span
      className={cx(styles.control, className)}
      data-invalid={rest["aria-invalid"] === true || undefined}
      data-disabled={disabled === true || undefined}
    >
      <select className={cx(styles.input, styles.select)} disabled={disabled} {...rest}>
        {children}
      </select>
    </span>
  );
}
