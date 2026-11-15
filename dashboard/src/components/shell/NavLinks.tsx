"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { consoleNav, isActive } from "@/lib/nav";

import { NavIcon } from "./NavIcon";
import styles from "./Shell.module.css";

export interface NavLinksProps {
  /** Badge counts per href, e.g. held intents on Activity. */
  counts?: Partial<Record<string, number>>;
  onNavigate?: () => void;
}

export function NavLinks({ counts = {}, onNavigate }: NavLinksProps) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className={styles.nav}>
      {consoleNav.map((item) => {
        const count = counts[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            className={styles.navLink}
            aria-current={isActive(pathname, item.href) ? "page" : undefined}
            onClick={onNavigate}
          >
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
            {count ? (
              <span className={styles.navCount}>
                {count}
                <span className="visually-hidden"> waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
