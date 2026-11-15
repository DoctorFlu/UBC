import type { CreateConnectorFn } from "wagmi";
import { createConfig, http, injected } from "wagmi";

import { targetChain } from "@/lib/chain";

/**
 * Builds the wagmi config. `extraConnectors` carries the dev signer when it is enabled; it is
 * passed in (not imported here) so builds without the flag never include the signer module.
 *
 * Extension point, WalletConnect: it needs a Reown project id. When the project has one, add
 * `walletConnect({ projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID })` from
 * "wagmi/connectors" to `connectors` and install `@walletconnect/ethereum-provider`.
 */
export function createWagmiConfig(extraConnectors: CreateConnectorFn[] = []) {
  return createConfig({
    chains: [targetChain],
    connectors: [injected({ shimDisconnect: true }), ...extraConnectors],
    transports: { [targetChain.id]: http() },
    // Server and first client render agree (disconnected); reconnection happens after hydration.
    ssr: true,
  });
}

export type WagmiConfig = ReturnType<typeof createWagmiConfig>;

declare module "wagmi" {
  interface Register {
    config: WagmiConfig;
  }
}
