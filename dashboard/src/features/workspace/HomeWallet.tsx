"use client";

import { Wallet } from "lucide-react";
import { type Address, isAddressEqual } from "viem";

import { WalletControl } from "@/components/shell/WalletControl";
import { Button } from "@/components/ui/Button";
import { shortenHex } from "@/lib/format";
import { useNetwork } from "@/lib/live/LiveConsole";
import { useConnectWallet } from "@/lib/wallet/connect";
import { useWalletState } from "@/lib/wallet/useWalletState";

import styles from "./workspace.module.css";

/**
 * The owner's wallet on Home, the owner's first screen: the same control as a mandate's top bar, checked
 * against every wallet-owned contract of the workspace (`owners`, the accounts they name).
 */
export function HomeWallet({ owners }: { owners: readonly Address[] }) {
  const network = useNetwork();
  const state = useWalletState();
  if (!network) return null;
  const address = state.kind === "connected" || state.kind === "wrong-network" ? state.address : null;
  const owns = address !== null && owners.some((owner) => isAddressEqual(owner, address));
  const named = [...new Set(owners.map((owner) => owner.toLowerCase()))];
  return (
    <WalletControl
      network={network}
      ownership={
        owns || address === null
          ? { kind: "owner" }
          : { kind: "not-owner", owner: named.length === 1 && owners[0] ? owners[0] : null }
      }
    />
  );
}

/**
 * A wallet-owned mandate's row says whether its owner can act from this browser, with the step when not:
 * connect, switch network, or the account the contract names when another one is connected.
 */
export function MandateOwnerLine({ owner }: { owner: Address | null }) {
  const network = useNetwork();
  const state = useWalletState();
  const connect = useConnectWallet();
  if (!network) return <p className={styles.rowMeta}>The owner&rsquo;s wallet signs</p>;
  let line;
  switch (state.kind) {
    case "loading":
      line = <span>The owner&rsquo;s wallet signs</span>;
      break;
    case "no-wallet":
      line = <span>Install a browser wallet, then connect the owner wallet to approve and change rules</span>;
      break;
    case "disconnected":
      line = (
        <>
          <span>Connect the owner wallet to approve and change rules</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<Wallet aria-hidden />}
            onClick={connect.start}
            loading={connect.connecting}
          >
            Connect wallet
          </Button>
        </>
      );
      break;
    case "wrong-network":
      line = <span>Switch the wallet to {network.name} to approve and change rules</span>;
      break;
    case "connected":
      line =
        owner === null ? (
          <span>The owner&rsquo;s wallet signs</span>
        ) : isAddressEqual(owner, state.address) ? (
          <span>Your wallet {shortenHex(state.address)} is the owner and signs</span>
        ) : (
          <span>
            The connected wallet is not the owner: the contract names{" "}
            <span className={styles.address} translate="no">
              {owner}
            </span>
          </span>
        );
      break;
  }
  return (
    <div className={styles.ownerLine} data-testid="mandate-owner-line" data-wallet-state={state.kind}>
      {line}
      {connect.chooser}
    </div>
  );
}
