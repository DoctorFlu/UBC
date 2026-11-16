"use client";

import { Field as FieldRoot, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/react/field";
import { Input as InputControl, InputGroup } from "@ui-sdk/react/input";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Field.module.css";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** A message saying what is wrong and how to fix it. Marks the control invalid. */
  error?: ReactNode;
  /** Marks the control invalid without a message here, when the message shows elsewhere. */
  invalid?: boolean;
  optional?: boolean;
  /** One control: an `Input`, a `Select` or another ui-sdk control. The field labels and describes it. */
  children: ReactNode;
  className?: string;
}

/** Label, hint and error around one control, wired for assistive technology. */
export function Field({ label, hint, error, invalid, optional = false, children, className }: FieldProps) {
  const isInvalid = invalid ?? error !== undefined;
  return (
    <FieldRoot className={cx(styles.field, className)} invalid={isInvalid ? true : undefined}>
      <FieldLabel className={styles.label}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </FieldLabel>
      {children}
      {error !== undefined ? (
        <FieldError match className={styles.error}>
          <CircleAlert aria-hidden strokeWidth={2.25} />
          <span>{error}</span>
        </FieldError>
      ) : null}
      {hint !== undefined ? <FieldDescription className={styles.hint}>{hint}</FieldDescription> : null}
    </FieldRoot>
  );
}

export interface InputProps extends Omit<ComponentProps<typeof InputControl>, "prefix" | "className"> {
  className?: string;
  /** Text before the value, e.g. "$". */
  prefix?: string;
  /** Text after the value, e.g. "USDC". */
  suffix?: string;
}

/** A text input in the console's control frame, with optional text before and after the value. */
export function Input({ prefix, suffix, className, ...rest }: InputProps) {
  return (
    <InputGroup className={cx(styles.control, className)}>
      {prefix ? (
        <span className={styles.affix} aria-hidden>
          {prefix}
        </span>
      ) : null}
      <InputControl className={styles.input} {...rest} />
      {suffix ? (
        <span className={styles.suffix} aria-hidden>
          {suffix}
        </span>
      ) : null}
    </InputGroup>
  );
}

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
}

export interface SelectProps<Value extends string> {
  options: readonly SelectOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Names the select when no `Field` label does. */
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}

/** A single choice from a short list, opened as a listbox anchored to its trigger. */
export function Select<Value extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  disabled,
  className,
}: SelectProps<Value>) {
  return (
    <SelectRoot
      items={[...options]}
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => option.value === next);
        if (match) onChange(match.value);
      }}
      disabled={disabled}
    >
      <SelectTrigger className={cx(styles.control, styles.selectTrigger, className)} aria-label={ariaLabel}>
        <SelectValue className={styles.selectValue} />
        <ChevronDown aria-hidden className={styles.chevron} strokeWidth={2} />
      </SelectTrigger>
      <SelectContent className={styles.selectContent}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className={styles.selectItem}>
            {option.label}
            <SelectItemIndicator className={styles.selectCheck}>
              <Check aria-hidden strokeWidth={2} />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
