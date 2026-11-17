"use client";

import { LayoutGrid, Menu, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { AccountView, MandateView } from "@/lib/accounts/types";

import { AccountBlock } from "./AccountBlock";
import { Brand } from "./Brand";
import { MandateSwitcher } from "./MandateSwitcher";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Home", icon: LayoutGrid },
  { href: "/mandates/new", label: "New mandate", icon: Plus },
] as const;

function WorkspaceNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace" className={styles.nav}>
      <ul className={styles.navGroup}>
        {LINKS.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className={styles.navLink}
              aria-current={pathname === href ? "page" : undefined}
              onClick={onNavigate}
            >
              <Icon aria-hidden strokeWidth={1.75} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The frame of the workspace's own pages (#95): every mandate at a glance and a new one. No mandate is
 * open, so there is no live lamp, wallet or kill switch here; each lives on its mandate's pages.
 */
export function WorkspaceShell({
  account,
  mandates,
  children,
}: {
  account: AccountView;
  mandates: readonly MandateView[];
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const foot = (
    <div className={styles.sidebarEnd}>
      <div className={styles.sidebarFoot}>
        <ThemeToggle />
      </div>
      <AccountBlock account={account} />
    </div>
  );
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <aside className={styles.sidebar} aria-label="Workspace">
        <div className={styles.sidebarInner}>
          <Brand />
          <MandateSwitcher mandates={mandates} current={null} />
          <WorkspaceNav />
          {foot}
        </div>
      </aside>
      <div className={styles.main}>
        <header className={`${styles.topbar} ${styles.workspaceTopbar}`}>
          <div className={styles.topbarStart}>
            <Button
              variant="ghost"
              iconOnly
              icon={<Menu aria-hidden />}
              aria-label="Open menu"
              aria-haspopup="dialog"
              onClick={() => setMenuOpen(true)}
            />
            <span className={styles.brandTop}>
              <Brand showTag={false} nameClassName={styles.brandNameTop} />
            </span>
          </div>
          <Dialog
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            title={<Brand showTag />}
            variant="drawer"
          >
            <div className={styles.drawerBody}>
              <MandateSwitcher mandates={mandates} current={null} onNavigate={() => setMenuOpen(false)} />
              <WorkspaceNav onNavigate={() => setMenuOpen(false)} />
              {foot}
            </div>
          </Dialog>
        </header>
        <main id="main" tabIndex={-1} className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
