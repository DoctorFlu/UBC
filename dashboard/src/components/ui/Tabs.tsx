"use client";

import { Tabs as TabsRoot, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Tabs.module.css";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** A count badge, e.g. intents waiting. */
  count?: number;
  content: ReactNode;
}

export interface TabsProps {
  /** Names the tab list for assistive technology. */
  label: string;
  tabs: readonly TabItem[];
  defaultTab?: string;
  /** Controlled selection, e.g. synced with the URL. */
  selected?: string;
  onSelect?: (id: string) => void;
  /** Pad the tab row to line up with a flush card's edges (tables run edge to edge below). */
  inset?: boolean;
  className?: string;
}

/** In-page tabs, where selection follows focus. Not for site navigation: routes use links. */
export function Tabs({ label, tabs, defaultTab, selected, onSelect, inset = false, className }: TabsProps) {
  return (
    <TabsRoot
      className={cx(styles.tabs, inset && styles.inset, className)}
      {...(selected === undefined
        ? { defaultValue: defaultTab ?? tabs[0]?.id ?? null }
        : { value: selected })}
      onValueChange={(value) => {
        if (value !== null) onSelect?.(value);
      }}
      loop
    >
      <TabsList aria-label={label} className={styles.list}>
        {tabs.map((tab) => (
          <TabsTab key={tab.id} value={tab.id} className={styles.tab}>
            {tab.label}
            {tab.count !== undefined ? <span className={styles.count}>{tab.count}</span> : null}
          </TabsTab>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsPanel key={tab.id} value={tab.id} className={styles.panel}>
          {tab.content}
        </TabsPanel>
      ))}
    </TabsRoot>
  );
}
