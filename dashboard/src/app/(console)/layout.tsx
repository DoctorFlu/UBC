import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ConsoleStateProvider } from "@/components/shell/ConsoleState";
import { WalletProvider } from "@/lib/wallet/WalletProvider";
import { mandate } from "@/mock";

/** Every owner view: wallet, console state and the shell. Public pages live outside this group. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <ConsoleStateProvider initialPaused={mandate.paused}>
        <AppShell>{children}</AppShell>
      </ConsoleStateProvider>
    </WalletProvider>
  );
}
