import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AGENT_ADDRESS, intents, liveStatus } from "@/mock";

import { Brand } from "./Brand";
import { NavLinks } from "./NavLinks";
import { PausedBanner } from "./PausedBanner";
import { ScheduleSummary } from "./ScheduleSummary";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { TopBar } from "./TopBar";

/** The console frame around every owner view. Views render only their own content inside it. */
export function AppShell({ children }: { children: ReactNode }) {
  const held = intents.filter((intent) => intent.status === "held").length;
  const navCounts = { "/activity": held };
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
            <Link href={`/agent/${AGENT_ADDRESS}`} className={styles.footLink}>
              <ExternalLink aria-hidden strokeWidth={1.75} />
              Public scorecard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <div className={styles.main}>
        <TopBar live={liveStatus} navCounts={navCounts} schedule={<ScheduleSummary />} />
        <PausedBanner />
        <main id="main" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
