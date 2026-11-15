"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { WagmiProvider, useConnect, useConnection, useConnectors } from "wagmi";

import { targetChain } from "@/lib/chain";

import { createWagmiConfig } from "./config";
import { devSigner } from "./dev-signer";
import { DEV_SIGNER_ENABLED, DEV_SIGNER_ID } from "./flags";

function makeConfig() {
  return createWagmiConfig(DEV_SIGNER_ENABLED ? [devSigner(targetChain)] : []);
}

/** wagmi and TanStack Query for the console. Mounted by the console layout only, never on public pages. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [config] = useState(makeConfig);
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {DEV_SIGNER_ENABLED ? <DevSignerAutoConnect /> : null}
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** With the dev signer on, connect it once on load so tests and demos start as the owner. */
function DevSignerAutoConnect() {
  const { status } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect } = useConnect();
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current || status !== "disconnected") return;
    const connector = connectors.find((candidate) => candidate.id === DEV_SIGNER_ID);
    if (!connector) return;
    tried.current = true;
    connect({ connector });
  }, [status, connectors, connect]);

  return null;
}
