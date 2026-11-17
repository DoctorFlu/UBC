"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { consoleNavGroups, isActive } from "@/lib/nav";

import { NavIcon } from "./NavIcon";
import styles from "./Shell.module.css";

export interface NavLinksProps {
  /** Badge counts per href, e.g. what waits on Approvals. */
  counts?: Partial<Record<string, number>>;
  onNavigate?: () => void;
}

/** The directory: three groups separated by hairlines. Every view is always listed, in any view mode. */
export function NavLinks({ counts = {}, onNavigate }: NavLinksProps) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className={styles.nav}>
      {consoleNavGroups.map((group) => (
        <ul key={group[0]?.href} className={styles.navGroup}>
          {group.map((item) => {
            const count = counts[item.href];
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={styles.navLink}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                  {count ? (
                    <span className={styles.navCount} data-testid={`nav-count-${item.icon}`}>
                      {count}
                      <span className="visually-hidden"> waiting</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}
