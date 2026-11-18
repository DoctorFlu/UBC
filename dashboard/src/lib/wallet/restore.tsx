"use client";

import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "wagmi";
import { connect, reconnect } from "wagmi/actions";

import type { WagmiConfig } from "./config";
import { DEV_SIGNER_ENABLED, DEV_SIGNER_ID } from "./flags";

/**
 * How long the console waits for a remembered wallet before it offers "Connect wallet" instead. A wallet
 * that is locked, asleep or busy with another request never answers `eth_accounts`, and waiting on it
 * would leave the wallet control blank for good; its late answer still connects.
 */
export const RESTORE_DEADLINE_MS = 2_000;

type Connection = NonNullable<ReturnType<WagmiConfig["state"]["connections"]["get"]>>;

export interface WalletRestore {
  /** True while the remembered wallet is restored on load, until it answers or the deadline passes. */
  restoring: boolean;
  /** The wallet that has not answered by the deadline ("MetaMask", or "Your wallet"), until one connects. */
  unanswered: string | null;
  /** The person's own connection: a restore that answers after it does not replace it. */
  connected: (uid: string) => void;
}

const RestoreContext = createContext<WalletRestore>({
  restoring: false,
  unanswered: null,
  connected: () => {},
});

export function useWalletRestore(): WalletRestore {
  return useContext(RestoreContext);
}

/** Announced wallets (EIP-6963), each its own connector, never the browser's one `window.ethereum`. */
function announced(config: WagmiConfig) {
  return config.connectors.filter(
    (connector) => connector.type === "injected" && connector.id !== "injected",
  );
}

/**
 * Before the chooser, the console connected through `window.ethereum` and remembered it as "injected". When
 * wallets announce themselves, that entry names whichever extension claimed `window.ethereum` last, under
 * the name "Injected", so it is dropped: each announced wallet the site may use reconnects under its own name.
 */
async function dropLegacyInjected(config: WagmiConfig) {
  if (announced(config).length === 0 || !config.storage) return;
  if ((await config.storage.getItem("recentConnectorId")) === "injected") {
    await config.storage.removeItem("recentConnectorId");
  }
  await config.storage.removeItem("injected.connected");
}

/** The wallet to name when the restore has not answered: the remembered one, or the only one installed. */
async function waitedOn(config: WagmiConfig): Promise<string> {
  const id = config.storage ? await config.storage.getItem("recentConnectorId") : null;
  const remembered = announced(config).find((connector) => connector.id === id);
  if (remembered) return remembered.name;
  const [only, ...others] = announced(config);
  return only && others.length === 0 ? only.name : "Your wallet";
}

/**
 * One restore per config, whatever mounts it (React mounts effects twice in development): the remembered
 * wallet, and in a dev build the dev signer when no wallet came back.
 */
const restores = new WeakMap<WagmiConfig, Promise<void>>();

function restoreOnce(config: WagmiConfig): Promise<void> {
  let restore = restores.get(config);
  if (!restore) {
    restore = (async () => {
      // WagmiProvider's own mount runs after its children's effects: it reads the stored state, adds the
      // announced wallets' connectors and clears stored connections, all from local storage. Start after it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await dropLegacyInjected(config).catch(() => {});
      await reconnect(config).catch(() => []);
      const devSigner = config.connectors.find((connector) => connector.id === DEV_SIGNER_ID);
      if (DEV_SIGNER_ENABLED && devSigner && config.state.status === "disconnected") {
        await connect(config, { connector: devSigner }).catch(() => {});
      }
    })();
    restores.set(config, restore);
  }
  return restore;
}

/**
 * Restores the owner's wallet on load with a deadline (the WagmiProvider's own reconnect is off). Until
 * the wallet answers or the deadline passes, wallet controls show a placeholder; after it, they offer
 * "Connect wallet", whose request is the one a locked wallet answers by asking to be unlocked.
 */
export function WalletRestoreProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const [restoring, setRestoring] = useState(true);
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const chosen = useRef<string | null>(null);
  const kept = useRef<Connection | null>(null);

  useEffect(() => {
    let live = true;
    let overdue = false;
    // wagmi's restore records each wallet that answers at once, but says "connected" only once every
    // wallet has answered, and only if nothing else changed the status meanwhile (a Connect the person
    // declined, say). Past the deadline, a wallet it recorded is connected, whatever the others do.
    const settle = () => {
      const { current, connections, status } = config.state;
      if (current !== null && connections.has(current) && status !== "connected") {
        config.setState((state) => ({ ...state, status: "connected" }));
      }
    };
    const deadline = setTimeout(() => {
      overdue = true;
      setRestoring(false);
      settle();
      void waitedOn(config).then((name) => {
        if (live && config.state.status !== "connected" && chosen.current === null) setUnanswered(name);
      });
    }, RESTORE_DEADLINE_MS);
    const unwatch = config.subscribe(
      (state) => state,
      (state) => {
        if (chosen.current !== null) {
          const own = state.connections.get(chosen.current);
          // The person's connection as it is now (its chain changes), to put back if a late restore replaces it.
          if (own && state.current === chosen.current) kept.current = own;
          // They disconnected it: nothing to put back.
          if (!own && state.status === "disconnected") {
            chosen.current = null;
            kept.current = null;
          }
        }
        if (state.status === "connected") setUnanswered(null);
        else if (overdue) settle();
      },
    );
    void restoreOnce(config).then(() => {
      clearTimeout(deadline);
      if (!live) return;
      overdue = true;
      setRestoring(false);
      setUnanswered(null);
      // wagmi's restore replaces every connection with the one that answered: when that answer came after
      // the person connected another wallet, theirs is the one that stays current.
      const own = chosen.current;
      const connection = kept.current;
      if (own !== null && connection && config.state.current !== own) {
        config.setState((state) => ({
          ...state,
          connections: new Map(state.connections).set(own, connection),
          current: own,
          status: "connected",
        }));
      }
      settle();
    });
    return () => {
      live = false;
      clearTimeout(deadline);
      unwatch();
    };
  }, [config]);

  const value = useMemo<WalletRestore>(
    () => ({
      restoring,
      unanswered,
      connected: (uid) => {
        chosen.current = uid;
        kept.current = config.state.connections.get(uid) ?? null;
      },
    }),
    [config, restoring, unanswered],
  );
  return <RestoreContext.Provider value={value}>{children}</RestoreContext.Provider>;
}
