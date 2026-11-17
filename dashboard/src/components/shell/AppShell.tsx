"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { needsOwner } from "@/lib/live/attention";
import { useSnapshot } from "@/lib/live/LiveConsole";

import { AdvancedToggle } from "./AdvancedToggle";
import { Brand } from "./Brand";
import { GetStarted } from "./GetStarted";
import { NavLinks } from "./NavLinks";
import { FeedNotice, PausedBanner } from "./PausedBanner";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { TopBar } from "./TopBar";

/** The console frame around every owner view. Views render only their own content inside it. */
export function AppShell({ children }: { children: ReactNode }) {
  const snapshot = useSnapshot();
  const navCounts = { "/approvals": needsOwner(snapshot).total };
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
          <SidebarFoot agent={agent} />
        </div>
      </aside>
      <div className={styles.main}>
        <TopBar navCounts={navCounts} foot={<SidebarFoot agent={agent} />} />
        <PausedBanner />
        <FeedNotice />
        <main id="main" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarFoot({ agent }: { agent: string | null }) {
  return (
    <div className={styles.sidebarEnd}>
      <GetStarted />
      <div className={styles.sidebarFoot}>
        {agent ? (
          <Link href={`/agent/${agent}`} className={styles.footLink}>
            <ExternalLink aria-hidden nonScalingStroke strokeWidth={1.5} />
            Public scorecard
          </Link>
        ) : null}
        <AdvancedToggle />
        <ThemeToggle />
      </div>
    </div>
  );
}
