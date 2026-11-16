"use client";

import type { ReactNode } from "react";

import { LiveConsoleProvider, useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { WalletProvider } from "@/lib/wallet/WalletProvider";

/** The live snapshot, then the wallet on the network that snapshot names. */
export function ConsoleProviders({
  initial,
  follow = true,
  children,
}: {
  initial: ConsoleSnapshot;
  follow?: boolean;
  children: ReactNode;
}) {
  return (
    <LiveConsoleProvider initial={initial} follow={follow}>
      <NetworkWallet>{children}</NetworkWallet>
    </LiveConsoleProvider>
  );
}

/** Remounts the wallet if the console's network changes (a devchain on another port, or Arc). */
function NetworkWallet({ children }: { children: ReactNode }) {
  const network = useSnapshot().network;
  return (
    <WalletProvider key={`${network.chainId.toString()}:${network.rpcUrl}`} network={network}>
      {children}
    </WalletProvider>
  );
}
