import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { WorkspaceShell } from "@/components/shell/WorkspaceShell";
import { AdvancedProvider } from "@/lib/advanced/Advanced";
import { ADVANCED_COOKIE } from "@/lib/advanced/cookie";
import { NetworkProvider } from "@/lib/live/LiveConsole";
import { WalletProvider } from "@/lib/wallet/WalletProvider";
import { getConsoleService } from "@/server/console";
import { accountView, workspaceMandates, workspaceScope } from "@/server/page-access";

export const dynamic = "force-dynamic";

/** The workspace's own pages (#95): Home and New mandate, around no single mandate. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { access } = await workspaceScope();
  const service = getConsoleService();
  const first = service.accounts.store.mandates(access.workspace.id)[0];
  const network = first ? service.snapshot(first).network : null;
  const advanced = (await cookies()).get(ADVANCED_COOKIE);
  const shell = (
    <AdvancedProvider cookie={advanced ? `${ADVANCED_COOKIE}=${advanced.value}` : null}>
      <WorkspaceShell account={accountView(access)} mandates={workspaceMandates(access)}>
        {children}
      </WorkspaceShell>
    </AdvancedProvider>
  );
  // The wallet too, so Home can connect the owner's wallet: it is the owner's first screen after the claim.
  return network ? (
    <NetworkProvider network={network}>
      <WalletProvider key={`${network.chainId.toString()}:${network.rpcUrl}`} network={network}>
        {shell}
      </WalletProvider>
    </NetworkProvider>
  ) : (
    shell
  );
}
