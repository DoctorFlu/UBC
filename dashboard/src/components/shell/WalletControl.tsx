"use client";

import { LogOut, TriangleAlert, Wallet } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";
import { useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { HexValue } from "@/components/ui/HexValue";
import { Skeleton } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { shortenHex } from "@/lib/format";
import type { ConsoleNetwork } from "@/lib/live/types";
import { declined, useConnectWallet } from "@/lib/wallet/connect";
import { useWalletState } from "@/lib/wallet/useWalletState";

import styles from "./Shell.module.css";

/**
 * Whether the connected wallet is the owner: of this mandate's contract in a mandate's pages, of any of
 * the workspace's wallet-owned contracts on Home. `owner` is the account the contract names, when one does.
 */
export type WalletOwnership = { kind: "owner" } | { kind: "not-owner"; owner: Address | null };

/**
 * The owner's wallet, in each of its states: no wallet installed, not connected (one wallet connects at
 * once, more open a chooser), wrong network (one click to switch to, or add, the console's network), and
 * connected, as the owner or not.
 */
export function WalletControl({
  network,
  ownership,
  block = false,
}: {
  network: Pick<ConsoleNetwork, "chainId" | "name">;
  ownership: WalletOwnership;
  block?: boolean;
}) {
  const state = useWalletState();
  const connect = useConnectWallet();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const { mutate: disconnect } = useDisconnect();
  const toast = useToast();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const notOwner = ownership.kind === "not-owner";

  let control;
  switch (state.kind) {
    case "loading":
      control = <Skeleton width="10.5rem" height="2.25rem" radius="var(--radius-sm)" />;
      break;
    case "no-wallet":
      control = (
        <Button
          variant="secondary"
          icon={<Wallet aria-hidden />}
          onClick={() => setHelpOpen(true)}
          block={block}
        >
          No wallet found
        </Button>
      );
      break;
    case "disconnected":
      control = (
        <Button
          variant="primary"
          icon={<Wallet aria-hidden />}
          onClick={connect.start}
          loading={connect.connecting}
          block={block}
        >
          Connect wallet
        </Button>
      );
      break;
    case "wrong-network":
      control = (
        <Button
          variant="dangerOutline"
          icon={<TriangleAlert aria-hidden />}
          onClick={() =>
            switchChain(
              { chainId: network.chainId },
              {
                onError: (error) =>
                  toast(
                    declined(error)
                      ? {
                          title: `Still on another network`,
                          description: `You declined in your wallet, so nothing changed. Press "Switch to ${network.name}" again when you are ready to sign as the owner.`,
                        }
                      : {
                          title: `Could not switch to ${network.name}`,
                          description: error.message.split("\n")[0],
                          tone: "danger",
                        },
                  ),
              },
            )
          }
          loading={switching}
          block={block}
        >
          Switch to {network.name}
        </Button>
      );
      break;
    case "connected":
      control = (
        <button
          type="button"
          className={styles.walletChip}
          onClick={() => setDetailsOpen(true)}
          data-testid="owner-address"
          data-address={state.address}
          data-owner={notOwner ? "false" : "true"}
          title={state.address}
        >
          <span className={styles.walletLamp} data-owner={notOwner ? "false" : undefined} aria-hidden />
          <span className={styles.walletRole}>{notOwner ? "Not owner" : "Owner"}</span>{" "}
          <span className={styles.walletAddress} translate="no">
            {shortenHex(state.address)}
          </span>
          <span className="visually-hidden">, wallet details</span>
        </button>
      );
      break;
  }

  return (
    <>
      <span className={styles.walletSlot} data-wallet-state={state.kind}>
        {control}
      </span>
      {state.kind === "connected" ? (
        <Dialog
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          title="Owner wallet"
          description="This wallet signs the rules, approvals and pauses."
          variant="sheet"
          footer={
            <Button
              variant="secondary"
              icon={<LogOut aria-hidden />}
              onClick={() => {
                disconnect();
                setDetailsOpen(false);
              }}
            >
              Disconnect
            </Button>
          }
        >
          <div className={styles.walletDetails}>
            <dl className={styles.walletDetailRows}>
              <dt>Address</dt>
              <dd>
                <HexValue value={state.address} kind="address" />
              </dd>
              <dt>Network</dt>
              <dd>
                {network.name}, chain {network.chainId}
              </dd>
              <dt>Role</dt>
              <dd>
                {ownership.kind === "owner" ? (
                  "Owner of the Policy contract"
                ) : ownership.owner ? (
                  <>
                    Not the owner. The Policy contract names{" "}
                    <HexValue value={ownership.owner} kind="address" /> as its owner and accepts only that
                    account&rsquo;s signature.
                  </>
                ) : (
                  "Not the owner of any of this workspace's contracts, so they would refuse its signature."
                )}
              </dd>
              <dt>Signer</dt>
              <dd>
                {state.isDevSigner
                  ? "Dev signer (public anvil test key)"
                  : state.walletName === "Injected"
                    ? "Browser wallet"
                    : `${state.walletName}, a browser wallet`}
              </dd>
            </dl>
          </div>
        </Dialog>
      ) : null}
      {connect.chooser}
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="No browser wallet found"
        description="The console needs a wallet extension to sign as the owner."
        footer={
          <Button variant="primary" onClick={() => setHelpOpen(false)}>
            Done
          </Button>
        }
      >
        <p>
          Install a wallet that supports custom networks, such as MetaMask or Rabby, then reload this page.
          The console adds {network.name} to it for you.
        </p>
      </Dialog>
    </>
  );
}
