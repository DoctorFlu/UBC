"use client";

import { Menu } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { type StreamConnection, useLiveConsole } from "@/lib/live/LiveConsole";

import { Brand } from "./Brand";
import { DevSignerBadge } from "./DevSignerBadge";
import { Isolator } from "./Isolator";
import { NavLinks } from "./NavLinks";
import styles from "./Shell.module.css";
import { WalletButton } from "./WalletButton";

export interface TopBarProps {
  navCounts: Partial<Record<string, number>>;
  /** The sidebar's footer (scorecard link, Advanced view, theme), repeated in the phone drawer. */
  foot: ReactNode;
}

/** How long the first connection may take before the lamp stops calling the page live. */
const SLOW_CONNECT_MS = 3_000;

/** True while the event stream has not opened after `SLOW_CONNECT_MS` (a proxy waking an idle console). */
function useSlowToConnect(connection: StreamConnection): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (connection !== "connecting") return undefined;
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [connection]);
  return slow && connection === "connecting";
}

/** The status strip: the live lamp, dev signer, wallet and the isolator. On phones, also the menu. */
export function TopBar({ navCounts, foot }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { snapshot, connection } = useLiveConsole();
  const slow = useSlowToConnect(connection);
  const { feed } = snapshot;
  const live = {
    source: feed.source,
    health:
      connection === "reconnecting"
        ? ("disconnected" as const)
        : slow
          ? ("connecting" as const)
          : feed.health,
    detail:
      connection === "reconnecting"
        ? "Lost the connection to the console server; reconnecting."
        : slow
          ? "Waiting for the console server to start sending updates. The page shows the state it loaded with."
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
        <span className={`${styles.mobileOnly} ${styles.brandTop}`}>
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
          {foot}
        </div>
      </Dialog>
    </header>
  );
}
