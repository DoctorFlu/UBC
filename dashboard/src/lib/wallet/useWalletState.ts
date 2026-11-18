"use client";

import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useConnection, useConnectors } from "wagmi";

import { useNetwork } from "@/lib/live/LiveConsole";

import { DEV_SIGNER_ID } from "./flags";

/**
 * The four wallet states the console designs for, plus "loading" while the wallet library
 * restores a previous session after hydration (render a same-size placeholder then).
 */
export type WalletState =
  | { kind: "loading" }
  | { kind: "no-wallet" }
  | { kind: "disconnected" }
  | { kind: "wrong-network"; address: Address; chainId: number | undefined }
  | { kind: "connected"; address: Address; isDevSigner: boolean; walletName: string };

const subscribeNoop = () => () => {};

function hasInjectedProvider(): boolean {
  return (
    typeof window !== "undefined" &&
    "ethereum" in window &&
    Boolean((window as { ethereum?: unknown }).ethereum)
  );
}

export function useWalletState(): WalletState {
  const network = useNetwork();
  const connection = useConnection();
  const connectors = useConnectors();
  // False on the server and during hydration, true afterwards: avoids a hydration mismatch.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  if (!mounted || connection.status === "reconnecting" || connection.status === "connecting") {
    return { kind: "loading" };
  }

  if (connection.status === "connected") {
    if (network && connection.chainId !== network.chainId) {
      return { kind: "wrong-network", address: connection.address, chainId: connection.chainId };
    }
    return {
      kind: "connected",
      address: connection.address,
      isDevSigner: connection.connector.id === DEV_SIGNER_ID,
      // The name the wallet announced (EIP-6963), or wagmi's "Injected" for a legacy provider.
      walletName: connection.connector.name,
    };
  }

  const hasDevSigner = connectors.some((connector) => connector.id === DEV_SIGNER_ID);
  const hasDiscovered = connectors.some(
    (connector) => connector.type === "injected" && connector.id !== "injected",
  );
  if (!hasInjectedProvider() && !hasDiscovered && !hasDevSigner) return { kind: "no-wallet" };
  return { kind: "disconnected" };
}
