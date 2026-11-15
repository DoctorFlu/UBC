"use client";

import { LogOut, TriangleAlert, Wallet } from "lucide-react";
import { useState } from "react";
import { useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { HexValue } from "@/components/ui/HexValue";
import { Skeleton } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { shortenHex } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { useOwnerAccess } from "@/lib/owner/access";
import { DEV_SIGNER_ID } from "@/lib/wallet/flags";
import { useWalletState } from "@/lib/wallet/useWalletState";

import styles from "./Shell.module.css";

/**
 * The owner's wallet, in each of its states: no wallet installed, not connected, wrong network
 * (one click to switch to, or add, the console's network), and connected.
 */
export function WalletButton({ block = false }: { block?: boolean }) {
  const state = useWalletState();
  const network = useSnapshot().network;
  const access = useOwnerAccess();
  const notOwner = access.kind === "not-owner";
  const connectors = useConnectors();
  const { mutate: connect, isPending: connecting } = useConnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const { mutate: disconnect } = useDisconnect();
  const toast = useToast();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Real wallets first; the dev signer only connects itself (see WalletProvider).
  const walletConnectors = connectors.filter((connector) => connector.id !== DEV_SIGNER_ID);

  const connectFirst = () => {
    const connector = walletConnectors[0];
    if (!connector) return;
    connect(
      { connector },
      {
        onError: (error) =>
          toast({ title: "Wallet not connected", description: error.message.split("\n")[0], tone: "danger" }),
      },
    );
  };

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
          onClick={connectFirst}
          loading={connecting}
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
                  toast({
                    title: `Could not switch to ${network.name}`,
                    description: error.message.split("\n")[0],
                    tone: "danger",
                  }),
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
          aria-label={`${notOwner ? "Connected wallet, not the owner," : "Owner wallet"} ${state.address}. Show details`}
        >
          <span className={styles.walletLamp} data-owner={notOwner ? "false" : undefined} aria-hidden />
          <span className={styles.walletRole}>{notOwner ? "Not owner" : "Owner"}</span>
          <span className={styles.walletAddress} translate="no">
            {shortenHex(state.address)}
          </span>
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
          description="This wallet signs the mandate, approvals and the kill switch."
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
                {notOwner
                  ? "Not the owner. The Policy contract only accepts the owner's signature."
                  : "Owner of the Policy contract"}
              </dd>
              <dt>Signer</dt>
              <dd>{state.isDevSigner ? "Dev signer (public anvil test key)" : "Browser wallet"}</dd>
            </dl>
          </div>
        </Dialog>
      ) : null}
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
