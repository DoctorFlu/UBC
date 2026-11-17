import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/AppShell";
import { ConsoleProviders } from "@/components/shell/ConsoleProviders";
import { AdvancedProvider } from "@/lib/advanced/Advanced";
import { ADVANCED_COOKIE } from "@/lib/advanced/cookie";
import { MandateProvider } from "@/lib/mandate/MandateContext";
import { getConsoleService } from "@/server/console";
import { accountView, pageScope, workspaceMandates } from "@/server/page-access";

// The console renders live state on every request; nothing here may be cached at build time.
export const dynamic = "force-dynamic";

/**
 * Every view of one mandate (#95): the session, the mandate the URL names (not found outside the member's
 * workspace), its live state, the wallet, the Advanced view preference and the shell. The live state is
 * keyed by the mandate, so switching never shows one mandate's state under another's name.
 */
export default async function MandateLayout({ children, params }: LayoutProps<"/m/[mandate]">) {
  const { mandate: mandateId } = await params;
  const { access, mandate } = await pageScope(mandateId);
  const mandates = workspaceMandates(access);
  const current = mandates.find((candidate) => candidate.id === mandate.id);
  if (!current) throw new Error("the mandate left the workspace while the page rendered");
  const snapshot = getConsoleService().snapshot(mandate);
  const advanced = (await cookies()).get(ADVANCED_COOKIE);
  return (
    <AdvancedProvider cookie={advanced ? `${ADVANCED_COOKIE}=${advanced.value}` : null}>
      <MandateProvider
        value={{
          mandate: current,
          mandates,
          deployer: getConsoleService().mandates.deployer(),
          canAct: access.member.role === "admin",
        }}
      >
        <ConsoleProviders key={mandate.id} initial={snapshot}>
          <AppShell account={accountView(access)}>{children}</AppShell>
        </ConsoleProviders>
      </MandateProvider>
    </AdvancedProvider>
  );
}
