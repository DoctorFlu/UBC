/**
 * The chain the console talks to, decided at runtime by the server (see server/ingest/deployment.ts)
 * and handed to the browser in the console snapshot. Nothing here is fixed at build time, so one build
 * serves the local devchain and Arc testnet alike.
 */
import { type FillSource, fillSourceOf } from "@mandate/shared";
import { type Chain, defineChain } from "viem";

import type { ChainView, ConsoleNetwork, NetworkKind, VenueAnnouncementView } from "@/lib/live/types";

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

type FillEvidence = Pick<ChainView, "venues" | "venueOrders" | "settlements" | "events">;

/** The block each filled intent's `ResultRecorded` was mined in, read once per chain view. */
const fillBlocksOf = new WeakMap<ChainView["events"], Map<number, number>>();

function fillBlock(chain: Pick<ChainView, "events">, intentId: number): number | null {
  let blocks = fillBlocksOf.get(chain.events);
  if (!blocks) {
    blocks = new Map();
    for (const event of chain.events) {
      if (event.type === "ResultRecorded") blocks.set(event.intentId, event.blockNumber);
    }
    fillBlocksOf.set(chain.events, blocks);
  }
  return blocks.get(intentId) ?? null;
}

/**
 * The announcement in force when a fill was mined in `block`: the latest whose start is at or before it.
 * The first announcement covers everything before the second, earlier fills included. With no block to go
 * by, only a lone announcement can say; among several, nothing does.
 */
export function announcementInForce(
  venues: readonly VenueAnnouncementView[],
  block: number | null,
): VenueAnnouncementView | null {
  const [first, ...later] = venues;
  if (!first) return null;
  if (block === null) return later.length === 0 ? first : null;
  let inForce = first;
  for (const announcement of later) {
    if (announcement.holdsFromBlock !== null && announcement.holdsFromBlock <= block) inForce = announcement;
  }
  return inForce;
}

/**
 * Where intent `intentId`'s fill came from, from what the executor signed, never from the chain: the order
 * it journaled for that intent (#93), else the venue its settlement names, else the venue announced when
 * its `ResultRecorded` was mined, never a later one. A Gemini executor journals every order, so a fill it
 * has no order for is `unknown`. With no announcement at all, a local devchain's fills are its in-process
 * simulator's; elsewhere they are unknown.
 */
export function fillSource(
  chain: FillEvidence,
  network: Pick<ConsoleNetwork, "kind">,
  intentId: number,
): FillSource {
  const settlement = chain.settlements[intentId];
  const inForce = announcementInForce(chain.venues, fillBlock(chain, intentId));
  return fillSourceOf({
    order: chain.venueOrders[intentId],
    settlementVenue: settlement?.status === "verified" ? settlement.document.venue : null,
    announced: inForce?.announced,
    fallback: chain.venues.length === 0 && network.kind === "local" ? "simulated" : "unknown",
  });
}

/**
 * Where this contract's orders are filled now, from the venue its executor last announced: what the top
 * bar says on every page, before any fill exists. Earlier fills keep the source they were filled with.
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

/** How many of a total's fills came from one source. */
export interface FillShare {
  source: FillSource;
  count: number;
}

/** Listed in this order: the source that most qualifies a total first, real money last. */
const SHARE_ORDER: readonly FillSource[] = ["simulated", "unknown", "sandbox", "live"];

/**
 * Where the fills of a total (a count, an amount, a P&L) came from, one share per source: one share when
 * every fill had the same source, several when they differ, none for no fills. A total of mixed fills
 * says each part, never one source for all.
 */
export function fillShares(
  chain: FillEvidence,
  network: Pick<ConsoleNetwork, "kind">,
  intentIds: Iterable<number>,
): FillShare[] {
  const counts = new Map<FillSource, number>();
  for (const id of intentIds) {
    const source = fillSource(chain, network, id);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return SHARE_ORDER.flatMap((source) => {
    const count = counts.get(source);
    return count === undefined ? [] : [{ source, count }];
  });
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
