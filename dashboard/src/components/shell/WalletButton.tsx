"use client";

import { KeyRound } from "lucide-react";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { useMandateScope } from "@/lib/mandate/MandateContext";
import { useOwnerAccess } from "@/lib/owner/access";

import styles from "./Shell.module.css";
import { WalletControl } from "./WalletControl";

/**
 * The owner's control in a mandate's top bar: the wallet (see WalletControl), checked against this
 * mandate's contract, or the passkey chip when the console holds the mandate's owner key.
 */
export function WalletButton({ block = false }: { block?: boolean }) {
  const network = useSnapshot().network;
  const access = useOwnerAccess();
  const scope = useMandateScope();
  const notOwner = access.kind === "not-owner";

  // The console holds this mandate's owner key (#95): no wallet signs here, the member's passkey confirms.
  if (scope?.mandate.ownerSigner === "console") {
    // The owner may have handed the contract to another account (`setUser`): the console's key is no
    // longer the owner, and no passkey action is offered.
    return (
      <span
        className={styles.walletChip}
        data-testid="passkey-owner"
        data-owner={notOwner ? "false" : "true"}
        title={
          notOwner
            ? access.reason
            : "The console holds this mandate's owner key. Each owner action asks for your passkey first."
        }
      >
        <KeyRound aria-hidden className={styles.walletKey} strokeWidth={1.75} />
        <span>{notOwner ? "Not owner" : "Passkey owner"}</span>
      </span>
    );
  }

  return (
    <WalletControl
      network={network}
      ownership={notOwner ? { kind: "not-owner", owner: access.owner } : { kind: "owner" }}
      block={block}
    />
  );
}
