"use client";

import { KeyRound, LogOut, TriangleAlert, Wallet } from "lucide-react";
import { useState } from "react";
import { type Connector, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { HexValue } from "@/components/ui/HexValue";
import { Skeleton } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { shortenHex } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { useMandateScope } from "@/lib/mandate/MandateContext";
import { useOwnerAccess } from "@/lib/owner/access";
import { useWalletState } from "@/lib/wallet/useWalletState";

import styles from "./Shell.module.css";

/** Whether the person said no in their wallet (EIP-1193 code 4001), however the wallet library wrapped it. */
function declined(error: unknown): boolean {
  for (
    let cause = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, name } = cause as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
  }
  return false;
}

/**
 * The wallets "Connect wallet" offers: each one that announced itself (EIP-6963, which wagmi discovers),
 * so MetaMask and Phantom in one browser are two choices, never whichever claimed `window.ethereum`. Only
 * when none announces does the browser's one legacy provider stand in. The dev signer connects itself.
 */
export function walletChoices(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.filter(
    (connector) => connector.type === "injected" && connector.id !== "injected",
  );
  return announced.length > 0 ? announced : connectors.filter((connector) => connector.id === "injected");
}

/**
 * The owner's wallet, in each of its states: no wallet installed, not connected, wrong network
 * (one click to switch to, or add, the console's network), and connected.
 */
export function WalletButton({ block = false }: { block?: boolean }) {
  const state = useWalletState();
  const network = useSnapshot().network;
  const access = useOwnerAccess();
  const scope = useMandateScope();
  const notOwner = access.kind === "not-owner";
  const connectors = useConnectors();
  const { mutate: connect, isPending: connecting } = useConnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const { mutate: disconnect } = useDisconnect();
  const toast = useToast();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);

  const choices = walletChoices(connectors);

  // wagmi keeps the wallet that connected (`recentConnectorId`) and reconnects to it on the next visit.
  const connectWith = (connector: Connector) =>
    connect(
      { connector },
      {
        onSuccess: () => setChooserOpen(false),
        onError: (error) =>
          toast(
            declined(error)
              ? {
                  title: "Wallet not connected",
                  description: `You declined in ${connector.name}, so nothing changed.`,
                }
              : { title: "Wallet not connected", description: error.message.split("\n")[0], tone: "danger" },
          ),
      },
    );

  // One wallet connects at once; with more, the owner picks the one that holds the owner's account.
  const startConnect = () => {
    const [first, ...others] = choices;
    if (!first) return;
    if (others.length === 0) connectWith(first);
    else setChooserOpen(true);
  };

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
          onClick={startConnect}
          loading={connecting && !chooserOpen}
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
                {notOwner ? (
                  <>
                    Not the owner. The Policy contract names <HexValue value={access.owner} kind="address" />{" "}
                    as its owner and accepts only that account&rsquo;s signature.
                  </>
                ) : (
                  "Owner of the Policy contract"
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
      <Dialog
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        title="Choose a wallet"
        description="More than one wallet is installed in this browser. Pick the one that holds the owner's account; the console reconnects to it next time."
      >
        <ul className={styles.walletChoices} aria-label="Wallets in this browser">
          {choices.map((connector) => (
            <li key={connector.uid}>
              <button
                type="button"
                className={styles.walletChoice}
                onClick={() => connectWith(connector)}
                disabled={connecting}
                data-testid="wallet-choice"
                data-wallet={connector.id}
              >
                {connector.icon ? (
                  // The wallet's own icon, a data URI it announced: nothing for next/image to optimise.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={connector.icon}
                    alt=""
                    width={28}
                    height={28}
                    className={styles.walletChoiceIcon}
                  />
                ) : (
                  <Wallet aria-hidden className={styles.walletChoiceIcon} strokeWidth={1.75} />
                )}
                <span>{connector.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
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
