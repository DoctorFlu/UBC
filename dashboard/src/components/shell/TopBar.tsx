"use client";

import { Menu } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { useLiveConsole } from "@/lib/live/LiveConsole";

import { Brand } from "./Brand";
import { DevSignerBadge } from "./DevSignerBadge";
import { Isolator } from "./Isolator";
import { NavLinks } from "./NavLinks";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";

export interface TopBarProps {
  navCounts: Partial<Record<string, number>>;
  /** The schedule of limits, rendered on the server and shown in the phone drawer. */
  schedule: ReactNode;
}

/** The status strip: the live feed, dev signer, wallet and the isolator. On phones, also the menu. */
export function TopBar({ navCounts, schedule }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { snapshot, connection } = useLiveConsole();
  const { feed } = snapshot;
  const live = {
    source: feed.source,
    health: connection === "reconnecting" ? ("disconnected" as const) : feed.health,
    detail:
      connection === "reconnecting"
        ? "Lost the connection to the console server; reconnecting."
        : feed.detail,
    lastEventAt: feed.lastEventAt,
  };
  return (
    <header className={styles.topbar}>
      <div className={styles.topbarStart}>
        <span className={styles.mobileOnly}>
          <Button
            variant="ghost"
            iconOnly
            icon={<Menu aria-hidden />}
            aria-label="Open menu"
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
          />
        </span>
        <span className={styles.mobileOnly}>
          <Brand showTag={false} nameClassName={styles.brandNameTop} />
        </span>
        <span className={styles.desktopOnly}>
          <LiveIndicator {...live} />
        </span>
      </div>
      <div className={styles.topbarEnd}>
        <span className={styles.mobileOnly}>
          <LiveIndicator {...live} compact />
        </span>
        <span className={styles.desktopOnly}>
          <DevSignerBadge />
        </span>
        <span className={styles.mobileOnly}>
          <DevSignerBadge short />
        </span>
        <span className={styles.desktopOnly}>
          <WalletButton />
        </span>
        <Isolator />
      </div>
      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title={<Brand showTag />} variant="drawer">
        <div className={styles.drawerBody}>
          <div className={styles.drawerWallet}>
            <WalletButton block />
          </div>
          <NavLinks counts={navCounts} onNavigate={() => setMenuOpen(false)} />
          {schedule}
          <ThemeToggle />
        </div>
      </Dialog>
    </header>
  );
}
