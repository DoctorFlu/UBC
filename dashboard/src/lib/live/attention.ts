/**
 * What waits for the owner, and what the owner already decided. Both are derived from the snapshot, so
 * Home, Approvals and the navigation badge always agree.
 */
import type { IntentView, PolicyChangeRequest } from "@mandate/shared";

import { waitingForApproval } from "./derive";
import type { ChainView, ConsoleSnapshot, PairingView } from "./types";

export interface Attention {
  /** Held intents, newest first. */
  intents: IntentView[];
  /** The agent's pending requests to change the rules, newest first. */
  changeRequests: PolicyChangeRequest[];
  /** An agent that announced itself and waits to be confirmed. */
  pairing: PairingView | null;
  total: number;
}

export function needsOwner(snapshot: ConsoleSnapshot): Attention {
  const intents = snapshot.chain ? waitingForApproval(snapshot.chain) : [];
  const changeRequests = snapshot.offchain.changeRequests.filter((request) => request.status === "pending");
  const pairing = snapshot.offchain.pairing?.status === "pending" ? snapshot.offchain.pairing : null;
  return {
    intents,
    changeRequests,
    pairing,
    total: intents.length + changeRequests.length + (pairing ? 1 : 0),
  };
}

export interface HeldDecision {
  intent: IntentView;
  /** Unix seconds of the block that decided it after the hold. */
  decidedAt: number | null;
}

/** Intents that waited for the owner and have since been decided, newest decision first. */
export function decidedAfterHold(chain: ChainView): HeldDecision[] {
  const held = new Set<number>();
  for (const event of chain.events) {
    if (event.type === "IntentNeedsApproval") held.add(event.intentId);
  }
  const decidedAt = new Map<number, number>();
  for (const event of chain.events) {
    if ((event.type === "IntentApproved" || event.type === "IntentRejected") && held.has(event.intentId)) {
      decidedAt.set(event.intentId, event.blockTimestamp);
    }
  }
  return chain.intents
    .filter((intent) => held.has(intent.id) && intent.status !== "needs_approval")
    .map((intent) => ({ intent, decidedAt: decidedAt.get(intent.id) ?? null }))
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || b.intent.id - a.intent.id);
}
