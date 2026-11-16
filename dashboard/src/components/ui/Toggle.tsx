"use client";

import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Toggle.module.css";

export interface ToggleProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** "compact" sets the label in the small muted style of the sidebar's footer. */
  size?: "default" | "compact";
  className?: string;
  "data-testid"?: string;
}

/** An on/off switch for a setting that applies at once. Pressing the label toggles it too. */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  size = "default",
  className,
  "data-testid": testId,
}: ToggleProps) {
  return (
    <Field className={cx(styles.toggle, size === "compact" && styles.compact, className)} disabled={disabled}>
      <span className={styles.text}>
        <FieldLabel className={styles.label}>{label}</FieldLabel>
        {description !== undefined ? (
          <FieldDescription className={styles.description}>{description}</FieldDescription>
        ) : null}
      </span>
      <Switch
        className={styles.switch}
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        data-testid={testId}
      >
        <SwitchThumb className={styles.thumb} />
      </Switch>
    </Field>
  );
}
