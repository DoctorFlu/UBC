import type { ReactNode } from "react";

import { PageHydrationBeacon } from "@/lib/page-hydration";

import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Small facts under the description, e.g. the mandate version and when it changed. */
  meta?: ReactNode;
  actions?: ReactNode;
}

/** The view's h1. Every route renders exactly one, so it also reports that the page has hydrated. */
export function PageHeader({ title, description, meta, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <PageHydrationBeacon />
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {description !== undefined ? <p className={styles.description}>{description}</p> : null}
        {meta !== undefined ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
