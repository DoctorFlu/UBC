"use client";

import { Wallet } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Connector, useConnect, useConnectors } from "wagmi";

import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";

import styles from "@/components/shell/Shell.module.css";

/** Whether the person said no in their wallet (EIP-1193 code 4001), however the wallet library wrapped it. */
export function declined(error: unknown): boolean {
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

export interface ConnectWallet {
  /** Connects the one wallet in the browser at once, or opens the chooser when there are more. */
  start: () => void;
  /** True while a wallet is asked, and the chooser is closed (a button then shows its spinner). */
  connecting: boolean;
  /** The chooser dialog: render it once, next to the control that calls `start`. */
  chooser: ReactNode;
}

/**
 * Connecting the owner's wallet, the same from every place that offers it (the top bar, Home, the setup
 * checklist). wagmi keeps the wallet that connected (`recentConnectorId`) and reconnects to it next time.
 */
export function useConnectWallet(): ConnectWallet {
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const toast = useToast();
  const [chooserOpen, setChooserOpen] = useState(false);
  const choices = walletChoices(connectors);

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

  const start = () => {
    const [first, ...others] = choices;
    if (!first) return;
    if (others.length === 0) connectWith(first);
    else setChooserOpen(true);
  };

  const chooser = (
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
              disabled={isPending}
              data-testid="wallet-choice"
              data-wallet={connector.id}
            >
              {connector.icon ? (
                // The wallet's own icon, a data URI it announced: nothing for next/image to optimise.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={connector.icon} alt="" width={28} height={28} className={styles.walletChoiceIcon} />
              ) : (
                <Wallet aria-hidden className={styles.walletChoiceIcon} strokeWidth={1.75} />
              )}
              <span>{connector.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );

  return { start, connecting: isPending && !chooserOpen, chooser };
}
