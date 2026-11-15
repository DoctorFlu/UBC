/**
 * Read-only views over a ChainView for the console's screens. Everything here is derived from the
 * Policy contract's events, so it is the same however the console was started or restarted.
 * "Today" follows the chain's clock (the newest block's timestamp) in UTC, like the contract's daily loss.
 */
import { type IntentStatus, type IntentView, type PolicyEvent, SECONDS_PER_DAY } from "@mandate/shared";

import type { ChainView, ConsoleSnapshot } from "./types";

export function utcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY);
}

export function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Intents, newest first. */
export function newestFirst(chain: ChainView): IntentView[] {
  return [...chain.intents].reverse();
}

export function waitingForApproval(chain: ChainView): IntentView[] {
  return newestFirst(chain).filter((intent) => intent.status === "needs_approval");
}

export interface TodayUsage {
  /** Proposals whose block is today. */
  intents: number;
  /** Rejections today, by the contract's reason string. */
  blockedByReason: Record<string, number>;
  blocked: number;
  /** Largest proposal today that the contract did not reject. */
  largestOrderCents: number;
  /** Intents that waited for the owner today. */
  heldForApproval: number;
}

export function todayUsage(chain: ChainView): TodayUsage {
  const today = utcDay(chain.head.timestamp);
  const isToday = (event: PolicyEvent) => utcDay(event.blockTimestamp) === today;
  const blockedByReason: Record<string, number> = {};
  let blocked = 0;
  let heldForApproval = 0;
  for (const event of chain.events) {
    if (!isToday(event)) continue;
    if (event.type === "IntentRejected") {
      blockedByReason[event.reason] = (blockedByReason[event.reason] ?? 0) + 1;
      blocked += 1;
    } else if (event.type === "IntentNeedsApproval") {
      heldForApproval += 1;
    }
  }
  let intents = 0;
  let largestOrderCents = 0;
  for (const intent of chain.intents) {
    if (utcDay(intent.proposedAt) !== today) continue;
    intents += 1;
    const rejectedAtProposal = intent.status === "rejected" && intent.decidedTxHash === intent.proposedTxHash;
    if (!rejectedAtProposal) largestOrderCents = Math.max(largestOrderCents, intent.amountCents ?? 0);
  }
  return { intents, blockedByReason, blocked, largestOrderCents, heldForApproval };
}

/** Every event about one intent, in chain order. */
export function intentEvents(chain: ChainView, intentId: number): PolicyEvent[] {
  return chain.events.filter((event) => "intentId" in event && event.intentId === intentId);
}

export function countByStatus(intents: readonly IntentView[], statuses: readonly IntentStatus[]): number {
  return intents.filter((intent) => statuses.includes(intent.status)).length;
}

/** Owner approvals so far: intents that needed approval and were then approved by `approveIntent`. */
export function ownerApprovals(chain: ChainView): number {
  const held = new Set<number>();
  let approvals = 0;
  for (const event of chain.events) {
    if (event.type === "IntentNeedsApproval") held.add(event.intentId);
    else if (event.type === "IntentApproved" && held.has(event.intentId)) approvals += 1;
  }
  return approvals;
}

/** The paired agent's name when it is the contract's agent, otherwise "The agent" ("the agent" mid-sentence). */
export function agentName(snapshot: ConsoleSnapshot, midSentence = false): string {
  const pairing = snapshot.offchain.pairing;
  if (pairing?.isContractAgent) return pairing.agentName;
  return midSentence ? "the agent" : "The agent";
}

/** The agent's own one-line reason for an intent, when its sealed decision context checks out. */
export function sealedReasonText(chain: ChainView, intentId: number): string | null {
  const sealed = chain.sealed[intentId];
  return sealed?.status === "verified" ? sealed.document.reason : null;
}
