import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ConsoleProviders } from "@/components/shell/ConsoleProviders";
import { getConsoleService } from "@/server/console";

// The console renders live state on every request; nothing here may be cached at build time.
export const dynamic = "force-dynamic";

/** Every owner view: live state, wallet and the shell. Public pages live outside this group. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const snapshot = getConsoleService().snapshot();
  return (
    <ConsoleProviders initial={snapshot}>
      <AppShell>{children}</AppShell>
    </ConsoleProviders>
  );
}
