import type { Hex } from "viem";
import type { PolicyState } from "./evaluate";
import { compareEvents, eventKey } from "./events";
import type { Intent, Policy, PolicyEvent } from "./types";

/**
 * Rebuilds the full Policy contract state from its events. The dashboard and the agent use this instead of
 * many view calls, and the devchain fuzz test checks it against the contract's own views.
 *
 * Guarantees:
 * - Deterministic: the result depends only on the set of events, never on delivery order.
 * - Idempotent: an event seen twice (same `transactionHash` and `logIndex`) is applied once.
 * - Out-of-order safe: an event older than the newest applied one triggers a rebuild in chain order.
 *
 * Per-intent records need `IntentProposed` (requested extension 2). Totals such as spend, losses and
 * rejection counts only need the spec events, so they stay correct even against a spec-only contract.
 */

export const SECONDS_PER_DAY = 86_400;

/** An intent as the event log describes it, with links to the transactions that changed it. */
export interface IntentView extends Intent {
  proposedTxHash: Hex;
  /** Transaction that gave the final verdict (approved or rejected), or null while none. */
  decidedTxHash: Hex | null;
  resultTxHash: Hex | null;
}

export interface EventCounts {
  proposed: number;
  approved: number;
  rejected: number;
  needsApproval: number;
  filled: number;
  unfilled: number;
}

export interface PolicyViewState {
  /** Latest policy, or null before the first `PolicySet`. Its `paused` always equals `paused` below. */
  policy: Policy | null;
  paused: boolean;
  /** Intents by id. */
  intents: Record<number, IntentView>;
  spentCents: number;
  /** Realized loss per UTC day number (`floor(unix seconds / 86400)`). */
  lossByDay: Record<number, number>;
  realizedPnlCents: number;
  rejectionsByReason: Record<string, number>;
  counts: EventCounts;
  /** Amounts of approved buys still waiting for a result, used to release unfilled budget. */
  openBuyAmounts: Record<number, number>;
  /** Every applied event, unique and in chain order. */
  events: PolicyEvent[];
}

export function emptyPolicyViewState(): PolicyViewState {
  return {
    policy: null,
    paused: false,
    intents: {},
    spentCents: 0,
    lossByDay: {},
    realizedPnlCents: 0,
    rejectionsByReason: {},
    counts: { proposed: 0, approved: 0, rejected: 0, needsApproval: 0, filled: 0, unfilled: 0 },
    openBuyAmounts: {},
    events: [],
  };
}

/** Builds state from any collection of events, in any order, with duplicates allowed. */
export function reduceEvents(events: Iterable<PolicyEvent>): PolicyViewState {
  const unique = new Map<string, PolicyEvent>();
  for (const event of events) {
    const key = eventKey(event);
    if (!unique.has(key)) unique.set(key, event);
  }
  const ordered = [...unique.values()].sort(compareEvents);
  const state = emptyPolicyViewState();
  for (const event of ordered) step(state, event);
  state.events = ordered;
  return state;
}

/** Returns a new state with `event` applied. The input state is never modified. */
export function applyEvent(state: PolicyViewState, event: PolicyEvent): PolicyViewState {
  const key = eventKey(event);
  if (state.events.some((e) => eventKey(e) === key)) return state;

  const last = state.events.at(-1);
  if (last !== undefined && compareEvents(event, last) < 0) {
    return reduceEvents([...state.events, event]);
  }

  const next = cloneState(state);
  step(next, event);
  next.events.push(event);
  return next;
}

export function applyEvents(state: PolicyViewState, events: Iterable<PolicyEvent>): PolicyViewState {
  let next = state;
  for (const event of events) next = applyEvent(next, event);
  return next;
}

/** UTC day number of a unix timestamp in seconds, as the contract computes it. */
export function utcDay(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY);
}

/** Realized loss recorded on the UTC day containing `nowSeconds`. */
export function lossTodayCents(state: PolicyViewState, nowSeconds: number): number {
  return state.lossByDay[utcDay(nowSeconds)] ?? 0;
}

/** The state `evaluateIntent` needs, as of `nowSeconds` (use the latest block's timestamp). */
export function policyStateAt(state: PolicyViewState, nowSeconds: number): PolicyState {
  return { spentCents: state.spentCents, lossTodayCents: lossTodayCents(state, nowSeconds) };
}

/** Intents in id order. */
export function listIntents(state: PolicyViewState): IntentView[] {
  return Object.values(state.intents).sort((a, b) => a.id - b.id);
}

/** Intents waiting for the owner, oldest first. */
export function pendingApprovals(state: PolicyViewState): IntentView[] {
  return listIntents(state).filter((intent) => intent.status === "needs_approval");
}

// ------------------------------------------------------------------ internals

function cloneState(state: PolicyViewState): PolicyViewState {
  return {
    ...state,
    intents: { ...state.intents },
    lossByDay: { ...state.lossByDay },
    rejectionsByReason: { ...state.rejectionsByReason },
    counts: { ...state.counts },
    openBuyAmounts: { ...state.openBuyAmounts },
    events: [...state.events],
  };
}

/** Applies one event in place. Only called on a fresh copy. Intent records are replaced, never mutated. */
function step(state: PolicyViewState, event: PolicyEvent): void {
  const updateIntent = (id: number, patch: Partial<IntentView>): void => {
    const existing = state.intents[id];
    if (existing) state.intents[id] = { ...existing, ...patch };
  };

  switch (event.type) {
    case "PolicySet":
      state.policy = { ...event.policy };
      state.paused = event.policy.paused;
      return;

    case "PausedSet":
      state.paused = event.paused;
      if (state.policy) state.policy = { ...state.policy, paused: event.paused };
      return;

    case "IntentProposed":
      state.counts.proposed += 1;
      state.intents[event.intentId] = {
        id: event.intentId,
        agent: event.agent,
        market: event.market,
        category: event.category,
        outcome: event.outcome,
        isBuy: event.isBuy,
        amountCents: event.amountCents,
        limitPrice: event.limitPrice,
        contextHash: event.contextHash,
        status: "none",
        reason: null,
        proposedAt: event.blockTimestamp,
        filledCents: null,
        pnlCents: null,
        proposedTxHash: event.transactionHash,
        decidedTxHash: null,
        resultTxHash: null,
      };
      return;

    case "IntentNeedsApproval":
      state.counts.needsApproval += 1;
      updateIntent(event.intentId, { status: "needs_approval" });
      return;

    case "IntentApproved":
      state.counts.approved += 1;
      if (event.isBuy) {
        state.spentCents += event.amountCents;
        state.openBuyAmounts[event.intentId] = event.amountCents;
      }
      updateIntent(event.intentId, { status: "approved", decidedTxHash: event.transactionHash });
      return;

    case "IntentRejected":
      state.counts.rejected += 1;
      state.rejectionsByReason[event.reason] = (state.rejectionsByReason[event.reason] ?? 0) + 1;
      updateIntent(event.intentId, {
        status: "rejected",
        reason: event.reason,
        decidedTxHash: event.transactionHash,
      });
      return;

    case "ResultRecorded": {
      if (event.filled) state.counts.filled += 1;
      else state.counts.unfilled += 1;

      const openBuy = state.openBuyAmounts[event.intentId];
      if (openBuy !== undefined) {
        state.spentCents += event.filledCents - openBuy;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- record keyed by intent id
        delete state.openBuyAmounts[event.intentId];
      }
      state.realizedPnlCents += event.pnlCents;
      if (event.pnlCents < 0) {
        const day = utcDay(event.blockTimestamp);
        state.lossByDay[day] = (state.lossByDay[day] ?? 0) - event.pnlCents;
      }
      updateIntent(event.intentId, {
        status: event.filled ? "filled" : "unfilled",
        filledCents: event.filledCents,
        pnlCents: event.pnlCents,
        resultTxHash: event.transactionHash,
      });
      return;
    }
  }
}
