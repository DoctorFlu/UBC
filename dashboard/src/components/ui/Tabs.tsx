"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

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

/**
 * In-page tabs (WAI-ARIA tabs pattern) with selection following focus and roving tabindex.
 * Not for site navigation: routes use links.
 */
export function Tabs({
  label,
  tabs,
  defaultTab,
  selected: controlled,
  onSelect,
  inset = false,
  className,
}: TabsProps) {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultTab ?? tabs[0]?.id ?? "");
  const selected = controlled ?? uncontrolled;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string, focus = false) => {
    if (controlled === undefined) setUncontrolled(id);
    onSelect?.(id);
    if (focus) tabRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === selected);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    const target = tabs[next];
    if (next < 0 || !target) return;
    event.preventDefault();
    select(target.id, true);
  };

  return (
    <div className={cx(styles.tabs, inset && styles.inset, className)}>
      <div role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              className={styles.tab}
              onClick={() => select(tab.id)}
            >
              {tab.label}
              {tab.count !== undefined ? <span className={styles.count}>{tab.count}</span> : null}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== selected}
          tabIndex={0}
          className={styles.panel}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
