"use client";

import { type Address, isAddressEqual } from "viem";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { type MandateScope, useMandateScope } from "@/lib/mandate/MandateContext";
import { useWalletState } from "@/lib/wallet/useWalletState";

/**
 * Whether this page may act as the owner: the Policy contract's `user()`. Every owner control reads this so
 * it can say exactly why it is disabled.
 *
 * `signer` says how (#95): `wallet`, the connected wallet is the owner and signs; `passkey`, the console
 * holds this mandate's owner key and signs once the member confirms each action with their passkey.
 */
export type OwnerAccess =
  | { kind: "owner"; address: Address; signer: "wallet" | "passkey" }
  | { kind: "loading" }
  | { kind: "no-contract"; reason: string }
  | { kind: "no-wallet"; reason: string }
  | { kind: "disconnected"; reason: string }
  | { kind: "wrong-network"; reason: string }
  | { kind: "viewer"; reason: string }
  | { kind: "not-owner"; address: Address; owner: Address; reason: string };

/**
 * How this mandate's owner acts, for copy that says so: `wallet`, the owner's own wallet signs (or the dev
 * signer on the demo chain); `passkey`, the console holds this mandate's owner key and the member's passkey
 * confirms each owner action (#95). A mandate the console is about to deploy is `passkey` already.
 */
export type OwnerMode = "wallet" | "passkey";

export function ownerModeOf(scope: MandateScope | null): OwnerMode {
  if (!scope) return "wallet";
  const { ownerSigner } = scope.mandate;
  if (ownerSigner === "console") return "passkey";
  if (ownerSigner === null && scope.deployer === "server") return "passkey";
  return "wallet";
}

export function useOwnerMode(): OwnerMode {
  return ownerModeOf(useMandateScope());
}

/** One sentence on how owner actions are made here, true for the mandate's owner mode. */
export const OWNER_MODE_TEXT: Record<OwnerMode, string> = {
  wallet: "The owner's wallet signs each owner action.",
  passkey: "The console holds this mandate's owner key; your passkey confirms each owner action.",
};

export function useOwnerAccess(): OwnerAccess {
  const wallet = useWalletState();
  const snapshot = useSnapshot();
  const scope = useMandateScope();
  const roles = snapshot.contract?.roles ?? null;
  if (!snapshot.contract) {
    return { kind: "no-contract", reason: "No Policy contract is configured yet." };
  }
  if (scope?.mandate.ownerSigner === "console") {
    if (!scope.canAct) {
      return { kind: "viewer", reason: "You can look but not change anything: ask a workspace admin." };
    }
    if (!roles) {
      return snapshot.feed.health === "offline"
        ? { kind: "no-contract", reason: "The chain is unreachable, so the owner can't be checked." }
        : { kind: "loading" };
    }
    const key = snapshot.contract.consoleOwnerKey;
    if (key !== null && !isAddressEqual(key, roles.user)) {
      return {
        kind: "not-owner",
        address: key,
        owner: roles.user,
        reason:
          "The owner handed this contract to another account, so the key the console holds can no longer act as the owner.",
      };
    }
    return { kind: "owner", address: roles.user, signer: "passkey" };
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
      return { kind: "owner", address: wallet.address, signer: "wallet" };
  }
}

/** The sentence to show next to a disabled owner control, or null when the owner can act. */
export function ownerBlockedReason(access: OwnerAccess): string | null {
  if (access.kind === "owner") return null;
  if (access.kind === "loading") return "Checking the owner.";
  return access.reason;
}

/**
 * A button's label for an owner action: the action itself when the wallet signs (the wallet then says what
 * it signs), or what the passkey will confirm, so one prompt is never a surprise.
 */
export function ownerActionLabel(access: OwnerAccess, action: string): string {
  return access.kind === "owner" && access.signer === "passkey" ? `${action} with passkey` : action;
}
