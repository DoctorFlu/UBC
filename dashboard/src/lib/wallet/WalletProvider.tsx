"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";

import type { ConsoleNetwork } from "@/lib/live/types";
import { viemChain } from "@/lib/network";

import { createWagmiConfig } from "./config";
import { devSigner } from "./dev-signer";
import { DEV_SIGNER_ENABLED } from "./flags";
import { WalletRestoreProvider } from "./restore";

function makeConfig(network: ConsoleNetwork) {
  const chain = viemChain(network);
  return createWagmiConfig(chain, DEV_SIGNER_ENABLED ? [devSigner(chain)] : []);
}

/**
 * wagmi and TanStack Query for the console, on the network the server reads. Mounted by the console
 * layout only, never on public pages. The layout remounts it (by key) if the network changes.
 *
 * The remembered wallet (and, with the dev signer on, the dev signer, so tests and demos start as the
 * owner) is restored by `WalletRestoreProvider`, with a deadline, rather than by wagmi on mount.
 */
export function WalletProvider({ network, children }: { network: ConsoleNetwork; children: ReactNode }) {
  const [config] = useState(() => makeConfig(network));
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <WalletRestoreProvider>{children}</WalletRestoreProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
