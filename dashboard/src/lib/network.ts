/**
 * The chain the console talks to, decided at runtime by the server (see server/ingest/deployment.ts)
 * and handed to the browser in the console snapshot. Nothing here is fixed at build time, so one build
 * serves the local devchain and Arc testnet alike.
 */
import { type FillSource, fillSourceOf } from "@mandate/shared";
import { type Chain, defineChain } from "viem";

import type { ChainView, ConsoleNetwork, NetworkKind } from "@/lib/live/types";

/** The short tag beside the logo, from the chain the console actually resolved. */
export const NETWORK_TAGS: Record<NetworkKind, string> = { local: "Local", "arc-testnet": "Arc testnet" };

/**
 * Where a fill came from, which the contract cannot say: it only knows the executor recorded one.
 * - `simulated`: the executor's simulated venue, which places nothing; the fill is real onchain, but no
 *   exchange saw the order. On any chain: the hosted Arc demo fills this way too.
 * - `sandbox`: Gemini's sandbox, with test funds.
 * - `live`: Gemini, with real money.
 * - `unknown`: the executor never said, so the console cannot say whether an exchange saw the order.
 */
export type { FillSource };

/**
 * Where intent `intentId`'s fill came from, from what the executor signed, never from the chain: the order
 * it journaled for that intent (#93), else the venue its settlement names, else the venue it announced for
 * the contract. A Gemini executor journals every order, so a fill it has no order for is `unknown`. With no
 * announcement at all, a local devchain's fills are its in-process simulator's; elsewhere they are unknown.
 */
export function fillSource(
  chain: Pick<ChainView, "venue" | "venueOrders" | "settlements">,
  network: Pick<ConsoleNetwork, "kind">,
  intentId: number,
): FillSource {
  const settlement = chain.settlements[intentId];
  return fillSourceOf({
    order: chain.venueOrders[intentId],
    settlementVenue: settlement?.status === "verified" ? settlement.document.venue : null,
    announced: chain.venue,
    fallback: network.kind === "local" ? "simulated" : "unknown",
  });
}

/**
 * Where this contract's orders are filled now, from the venue its executor announced (`fillSource` with no
 * intent of its own): what the top bar says on every page, before any fill exists.
 */
export function contractFillSource(
  chain: Pick<ChainView, "venue">,
  network: Pick<ConsoleNetwork, "kind">,
): FillSource {
  const venue = chain.venue;
  if (venue) {
    if (venue.venue === "simulated") return "simulated";
    return venue.environment === "production" ? "live" : "sandbox";
  }
  return network.kind === "local" ? "simulated" : "unknown";
}

/** Labelled in this order when a total mixes fills of several sources: the one that most qualifies it. */
const QUALIFYING: readonly FillSource[] = ["simulated", "unknown", "sandbox"];

/**
 * The label a total of the fills `intentIds` carries (a count, an amount, a P&L): the source that most
 * qualifies any of them, or `live` when every one was filled with real money (or there are none).
 */
export function fillsSource(
  chain: Pick<ChainView, "venue" | "venueOrders" | "settlements">,
  network: Pick<ConsoleNetwork, "kind">,
  intentIds: Iterable<number>,
): FillSource {
  const sources = new Set<FillSource>();
  for (const id of intentIds) sources.add(fillSource(chain, network, id));
  return QUALIFYING.find((source) => sources.has(source)) ?? "live";
}

/** Every intent the contract recorded as filled. */
export function filledIntentIds(chain: Pick<ChainView, "intents">): number[] {
  return chain.intents.flatMap((intent) => (intent.status === "executed" ? [intent.id] : []));
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
