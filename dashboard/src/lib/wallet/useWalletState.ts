"use client";

import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useConnection, useConnectors } from "wagmi";

import { useNetwork } from "@/lib/live/LiveConsole";

import { DEV_SIGNER_ID } from "./flags";
import { useWalletRestore } from "./restore";

/**
 * The four wallet states the console designs for, plus "loading" while the remembered wallet is
 * restored after hydration, at most `RESTORE_DEADLINE_MS` (render a same-size placeholder then).
 */
export type WalletState =
  | { kind: "loading" }
  | { kind: "no-wallet" }
  /** `unanswered` names the wallet that did not answer on load (it may be locked), until one connects. */
  | { kind: "disconnected"; unanswered: string | null }
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
  const restore = useWalletRestore();
  // False on the server and during hydration, true afterwards: avoids a hydration mismatch.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  // Only the restore on load shows a placeholder, and only until its deadline. A connection the person
  // started keeps the control actionable (its button shows that it is waiting on the wallet).
  if (!mounted || restore.restoring) return { kind: "loading" };

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
  return { kind: "disconnected", unanswered: restore.unanswered };
}
