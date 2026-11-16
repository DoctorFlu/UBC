import type { Chain } from "viem";
import type { CreateConnectorFn } from "wagmi";
import { createConfig, http, injected } from "wagmi";

/**
 * Builds the wagmi config for the one chain the console serves (see lib/network.ts). `extraConnectors` carries the dev signer when it is enabled; it is
 * passed in (not imported here) so builds without the flag never include the signer module.
 *
 * Extension point, WalletConnect: it needs a Reown project id. When the project has one, add
 * `walletConnect({ projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID })` from
 * "wagmi/connectors" to `connectors` and install `@walletconnect/ethereum-provider`.
 */
export function createWagmiConfig(chain: Chain, extraConnectors: CreateConnectorFn[] = []) {
  return createConfig({
    chains: [chain],
    connectors: [injected({ shimDisconnect: true }), ...extraConnectors],
    transports: { [chain.id]: http() },
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
