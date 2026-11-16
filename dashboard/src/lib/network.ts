/**
 * The chain the console talks to, decided at runtime by the server (see server/ingest/deployment.ts)
 * and handed to the browser in the console snapshot. Nothing here is fixed at build time, so one build
 * serves the local devchain and Arc testnet alike.
 */
import { type Chain, defineChain } from "viem";

import type { ConsoleNetwork, NetworkKind } from "@/lib/live/types";

/** The short tag beside the logo, from the chain the console actually resolved. */
export const NETWORK_TAGS: Record<NetworkKind, string> = { local: "Local", "arc-testnet": "Arc testnet" };

/**
 * Whether fills are simulated. On the local devchain the executor is the devchain's simulator, so a
 * recorded fill never touched an exchange; elsewhere the contract only knows the executor recorded it.
 */
export function fillsAreSimulated(network: Pick<ConsoleNetwork, "kind">): boolean {
  return network.kind === "local";
}

/** A viem chain for the network: the RPC the browser may use and, on Arc, the explorer. */
export function viemChain(network: ConsoleNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    // Arc's gas token is USDC. As the native currency it uses 18 decimals, unlike the 6-decimal ERC-20.
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    ...(network.explorerUrl
      ? { blockExplorers: { default: { name: "Arc explorer", url: network.explorerUrl } } }
      : {}),
    testnet: true,
  });
}

export function explorerTxUrl(
  network: Pick<ConsoleNetwork, "explorerUrl">,
  hash: string,
): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(
  network: Pick<ConsoleNetwork, "explorerUrl">,
  address: string,
): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/address/${address}` : undefined;
}

export function explorerBlockUrl(
  network: Pick<ConsoleNetwork, "explorerUrl">,
  block: number | bigint,
): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/block/${block.toString()}` : undefined;
}
