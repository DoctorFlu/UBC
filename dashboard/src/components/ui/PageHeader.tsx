import type { ReactNode } from "react";

import { PageHydrationBeacon } from "@/lib/page-hydration";

import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Small facts under the description, e.g. the mandate version and when it changed. */
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * False for the route's loading fallback, which hydrates with the shell before the page itself: only
   * the page may report that it hydrated (see lib/page-hydration.ts).
   */
  reportsHydration?: boolean;
}

/** The view's h1. Every route renders exactly one, so it also reports that the page has hydrated. */
export function PageHeader({ title, description, meta, actions, reportsHydration = true }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      {reportsHydration ? <PageHydrationBeacon /> : null}
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {description !== undefined ? <p className={styles.description}>{description}</p> : null}
        {meta !== undefined ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
