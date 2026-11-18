"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { AccountView } from "@/lib/accounts/types";
import { needsOwner } from "@/lib/live/attention";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { useMandateScope } from "@/lib/mandate/MandateContext";

import { AccountBlock } from "./AccountBlock";
import { AdvancedToggle } from "./AdvancedToggle";
import { Brand } from "./Brand";
import { GetStarted } from "./GetStarted";
import { MandateSwitcher } from "./MandateSwitcher";
import { NavLinks } from "./NavLinks";
import { FeedNotice, PausedBanner, WalletNotice } from "./PausedBanner";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { TopBar } from "./TopBar";

/** The console frame around every owner view. Views render only their own content inside it. */
export function AppShell({ account, children }: { account: AccountView; children: ReactNode }) {
  const snapshot = useSnapshot();
  const navCounts = { "/approvals": needsOwner(snapshot).total };
  const scope = useMandateScope();
  // Only the first mandate's agent has a public scorecard (the server's own contract, docs/accounts.md):
  // another mandate's link would be a 404.
  const agent = scope?.mandate.deployment === "env" ? (snapshot.contract?.roles?.agent ?? null) : null;
  const switcher = scope ? <MandateSwitcher mandates={scope.mandates} current={scope.mandate} /> : null;
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <aside className={styles.sidebar} aria-label="Console">
        <div className={styles.sidebarInner}>
          <Brand />
          {switcher}
          <NavLinks counts={navCounts} />
          <SidebarFoot agent={agent} account={account} />
        </div>
      </aside>
      <div className={styles.main}>
        <TopBar navCounts={navCounts} foot={<SidebarFoot agent={agent} account={account} />} />
        <PausedBanner />
        <FeedNotice />
        <WalletNotice />
        <main id="main" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarFoot({ agent, account }: { agent: string | null; account: AccountView }) {
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
      <AccountBlock account={account} />
    </div>
  );
}
