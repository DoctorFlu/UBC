import type { ReactNode } from "react";

import { BrandMark } from "@/components/shell/Brand";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

import styles from "./auth.module.css";

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <BrandMark />
          <span className={styles.brandName}>Mandate</span>
        </span>
        <ThemeToggle />
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}

export function AuthCard({
  title,
  lead,
  children,
  links,
}: {
  title: string;
  lead: ReactNode;
  children: ReactNode;
  links?: ReactNode;
}) {
  return (
    <>
      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.heading}>
          <h1 id="auth-title" className={styles.title}>
            {title}
          </h1>
          <p className={styles.lead}>{lead}</p>
        </div>
        {children}
      </section>
      {links ? <ul className={styles.links}>{links}</ul> : null}
    </>
  );
}
