"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { useSnapshot } from "@/lib/live/LiveConsole";

import { Brand } from "./Brand";
import { NavLinks } from "./NavLinks";
import { FeedNotice, PausedBanner } from "./PausedBanner";
import { ScheduleSummary } from "./ScheduleSummary";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { TopBar } from "./TopBar";

/** The console frame around every owner view. Views render only their own content inside it. */
export function AppShell({ children }: { children: ReactNode }) {
  const snapshot = useSnapshot();
  const waiting = snapshot.chain?.intents.filter((intent) => intent.status === "needs_approval").length ?? 0;
  const navCounts = { "/activity": waiting };
  const agent = snapshot.contract?.roles?.agent ?? null;
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <aside className={styles.sidebar} aria-label="Console">
        <div className={styles.sidebarInner}>
          <Brand />
          <NavLinks counts={navCounts} />
          <ScheduleSummary />
          <div className={styles.sidebarFoot}>
            {agent ? (
              <Link href={`/agent/${agent}`} className={styles.footLink}>
                <ExternalLink aria-hidden strokeWidth={1.75} />
                Public scorecard
              </Link>
            ) : null}
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <div className={styles.main}>
        <TopBar navCounts={navCounts} schedule={<ScheduleSummary />} />
        <PausedBanner />
        <FeedNotice />
        <main id="main" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
