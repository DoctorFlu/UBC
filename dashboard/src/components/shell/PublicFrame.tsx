import type { ReactNode } from "react";

import { BrandMark } from "./Brand";
import styles from "./PublicFrame.module.css";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The frame for pages outside the console: the public dashboard and the component gallery.
 * No wallet, no console navigation, nothing that needs the owner.
 */
export function PublicFrame({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <BrandMark />
          <span className={styles.brandName}>Mandate</span>
          <span className={styles.brandNote}>{note}</span>
        </span>
        <ThemeToggle />
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
