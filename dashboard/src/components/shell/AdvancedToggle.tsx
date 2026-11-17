"use client";

import { Toggle } from "@/components/ui/Toggle";
import { useAdvanced } from "@/lib/advanced/Advanced";

import styles from "./Shell.module.css";

/** The one switch between the plain view and Advanced view, which adds hashes, symbols and diagnostics. */
export function AdvancedToggle() {
  const { advanced, setAdvanced } = useAdvanced();
  return (
    <Toggle
      className={styles.advancedToggle}
      size="compact"
      label="Advanced view"
      checked={advanced}
      onChange={setAdvanced}
      data-testid="advanced-toggle"
    />
  );
}
