"use client";

import { type Address, isAddressEqual } from "viem";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { useWalletState } from "@/lib/wallet/useWalletState";

/**
 * Whether the connected wallet may act as the owner: the Policy contract's `user()`. Every owner
 * control reads this so it can say exactly why it is disabled.
 */
export type OwnerAccess =
  | { kind: "owner"; address: Address }
  | { kind: "loading" }
  | { kind: "no-contract"; reason: string }
  | { kind: "no-wallet"; reason: string }
  | { kind: "disconnected"; reason: string }
  | { kind: "wrong-network"; reason: string }
  | { kind: "not-owner"; address: Address; owner: Address; reason: string };

export function useOwnerAccess(): OwnerAccess {
  const wallet = useWalletState();
  const snapshot = useSnapshot();
  const roles = snapshot.contract?.roles ?? null;
  if (!snapshot.contract) {
    return { kind: "no-contract", reason: "No Policy contract is configured yet." };
  }
  switch (wallet.kind) {
    case "loading":
      return { kind: "loading" };
    case "no-wallet":
      return { kind: "no-wallet", reason: "Install a browser wallet to sign as the owner." };
    case "disconnected":
      return { kind: "disconnected", reason: "Connect the owner wallet to sign." };
    case "wrong-network":
      return { kind: "wrong-network", reason: `Switch your wallet to ${snapshot.network.name} to sign.` };
    case "connected":
      if (!roles) {
        return snapshot.feed.health === "offline"
          ? { kind: "no-contract", reason: "The chain is unreachable, so the owner can't be checked." }
          : { kind: "loading" };
      }
      if (!isAddressEqual(wallet.address, roles.user)) {
        return {
          kind: "not-owner",
          address: wallet.address,
          owner: roles.user,
          reason: "This wallet is not the Policy contract's owner, so the contract would refuse it.",
        };
      }
      return { kind: "owner", address: wallet.address };
  }
}

/** The sentence to show next to a disabled owner control, or null when the owner can act. */
export function ownerBlockedReason(access: OwnerAccess): string | null {
  if (access.kind === "owner") return null;
  if (access.kind === "loading") return "Checking the owner wallet.";
  return access.reason;
}
