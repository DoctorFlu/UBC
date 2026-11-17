"use client";

import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { MandateView } from "@/lib/accounts/types";
import { mandatePath, viewPathOf } from "@/lib/mandate-path";

import styles from "./MandateSwitcher.module.css";

/** The same view in another mandate: its list, never one record (intent 3 of one mandate is not another's). */
function sameViewIn(pathname: string, mandateId: string): string {
  const view = viewPathOf(pathname)?.path ?? "/";
  const section = view.split("/")[1] ?? "";
  return mandatePath(mandateId, section === "" ? "" : `/${section}`);
}

export interface MandateSwitcherProps {
  mandates: readonly MandateView[];
  /** The mandate the page shows; null on the workspace's own pages. */
  current: MandateView | null;
  onNavigate?: () => void;
}

/** Which mandate the console shows, and the way to another one, to the workspace Home or to a new one. */
export function MandateSwitcher({ mandates, current, onNavigate }: MandateSwitcherProps) {
  const pathname = usePathname();
  return (
    <Menu>
      <MenuTrigger
        className={styles.trigger}
        aria-label={current ? `Mandate: ${current.name}. Switch mandate` : "Choose a mandate"}
        data-testid="mandate-switcher"
      >
        <span className={styles.triggerText}>
          <span className={styles.triggerLabel}>Mandate</span>
          <span className={styles.triggerName}>{current ? current.name : "All mandates"}</span>
        </span>
        <ChevronsUpDown aria-hidden className={styles.chevron} strokeWidth={1.75} />
      </MenuTrigger>
      <MenuContent className={styles.content} side="bottom" align="start" sideOffset={4}>
        <MenuGroup>
          <MenuGroupLabel className={styles.groupLabel}>Mandates</MenuGroupLabel>
          {mandates.map((mandate) => {
            const selected = mandate.id === current?.id;
            return (
              <MenuItem
                key={mandate.id}
                className={styles.item}
                label={mandate.name}
                render={
                  <Link
                    href={sameViewIn(pathname, mandate.id)}
                    aria-current={selected ? "page" : undefined}
                    onClick={onNavigate}
                  />
                }
              >
                <span className={styles.itemName}>{mandate.name}</span>
                {selected ? <Check aria-hidden className={styles.check} strokeWidth={2} /> : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator className={styles.separator} />
        <MenuItem
          className={styles.item}
          label="All mandates"
          render={
            <Link
              href="/"
              aria-current={current === null && pathname === "/" ? "page" : undefined}
              onClick={onNavigate}
            />
          }
        >
          <LayoutGrid aria-hidden className={styles.icon} strokeWidth={1.75} />
          <span className={styles.itemName}>All mandates</span>
        </MenuItem>
        <MenuItem
          className={styles.item}
          label="New mandate"
          render={<Link href="/mandates/new" onClick={onNavigate} />}
        >
          <Plus aria-hidden className={styles.icon} strokeWidth={1.75} />
          <span className={styles.itemName}>New mandate</span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
