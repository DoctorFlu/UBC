import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ConsoleProviders } from "@/components/shell/ConsoleProviders";
import { AdvancedProvider } from "@/lib/advanced/Advanced";
import { ADVANCED_COOKIE } from "@/lib/advanced/cookie";
import { getConsoleService } from "@/server/console";
import { accountView, pageScope } from "@/server/page-access";

// The console renders live state on every request; nothing here may be cached at build time.
export const dynamic = "force-dynamic";

/** Every owner view: the session, live state, wallet, the Advanced view preference and the shell. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { access, mandate } = await pageScope();
  const snapshot = getConsoleService().snapshot(mandate);
  const advanced = (await cookies()).get(ADVANCED_COOKIE);
  return (
    <AdvancedProvider cookie={advanced ? `${ADVANCED_COOKIE}=${advanced.value}` : null}>
      <ConsoleProviders initial={snapshot}>
        <AppShell account={accountView(access)}>{children}</AppShell>
      </ConsoleProviders>
    </AdvancedProvider>
  );
}
