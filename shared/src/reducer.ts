import type { Address, Hex } from "viem";
import type { MarketListing } from "./anomalies";
import type { PolicyState } from "./evaluate";
import { compareEvents, eventKey } from "./events";
import type { IntentStatus } from "./reasons";
import type { Intent, OutOfRange, PolicyEvent, PolicyRules } from "./types";

/**
 * Rebuilds the full Policy contract state from its events. The dashboard and the agent use this instead of
 * many view calls, and the devchain tests check it against the contract's own views.
 *
 * Guarantees:
 * - Deterministic: the result depends only on the set of events, never on delivery order.
 * - Idempotent: an event seen twice (same `transactionHash` and `logIndex`) is applied once.
 * - Out-of-order safe: an event older than the newest applied one triggers a rebuild in chain order.
 *
 * Works with the production contract's events alone. Totals (committed spend, losses, rejection counts)
 * are always exact. Per-intent details are exact when the contract emits `IntentProposed` (requested
 * extension 1); without it, an intent rejected at proposal has no market or amount in the log, so those
 * fields stay null until `mergeIntentDetails` fills them from `getIntent`.
 */

export const SECONDS_PER_DAY = 86_400;

/** An intent as the event log describes it. Detail fields are null when no event carried them. */
export interface IntentView {
  id: number;
  status: IntentStatus;
  /** Rejection reason, or null when not rejected. */
  reason: string | null;
  market: string | null;
  category: number | null;
  outcome: string | null;
  isBuy: boolean | null;
  amountCents: number | null;
  limitPrice: number | null;
  /** Only known from `IntentProposed`. */
  agent: Address | null;
  /** Only known from `IntentProposed`. */
  contextHash: Hex | null;
  /** Unix seconds of the first event seen for the intent, which is the proposal when history is complete. */
  proposedAt: number;
  /** Set once a result is recorded. */
  filledCents: number | null;
  pnlCents: number | null;
  /**
   * Fields above that are null because the value on chain does not fit a number, with the exact value.
   * Absent when every number fits. Only a key other than this system's (a stolen agent key) writes these.
   */
  outOfRange?: OutOfRange;
  /**
   * Gemini's listing of `market` as a reader that checks it (the console) first saw it. Never set from the
   * chain; absent until checked. `intentAnomalies` flags a market Gemini does not list or lists elsewhere.
   */
  listing?: MarketListing;
  /** Transaction that proposed the intent (the first event seen for it). */
  proposedTxHash: Hex;
  /** Transaction that approved or rejected it, or null while none. */
  decidedTxHash: Hex | null;
  resultTxHash: Hex | null;
}

export interface EventCounts {
  /** Intents seen, by any event. */
  proposed: number;
  approved: number;
  rejected: number;
  needsApproval: number;
  executed: number;
  failed: number;
}

export interface PolicyViewState {
  /** Latest rules, or null before the first `PolicyUpdated`. Its `paused` always equals `paused` below. */
  rules: PolicyRules | null;
  paused: boolean;
  /** Intents by id. */
  intents: Record<number, IntentView>;
  committedCents: number;
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
    rules: null,
    paused: false,
    intents: {},
    committedCents: 0,
    lossByDay: {},
    realizedPnlCents: 0,
    rejectionsByReason: {},
    counts: { proposed: 0, approved: 0, rejected: 0, needsApproval: 0, executed: 0, failed: 0 },
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
  return { committedCents: state.committedCents, lossTodayCents: lossTodayCents(state, nowSeconds) };
}

/** Intents in id order. */
export function listIntents(state: PolicyViewState): IntentView[] {
  return Object.values(state.intents).sort((a, b) => a.id - b.id);
}

/** Intents waiting for the user, oldest first. */
export function pendingApprovals(state: PolicyViewState): IntentView[] {
  return listIntents(state).filter((intent) => intent.status === "needs_approval");
}

/** Ids of intents whose details the log did not carry, to read with `getIntent`. */
export function intentsMissingDetails(state: PolicyViewState): number[] {
  return listIntents(state)
    .filter((intent) => intent.market === null || intent.category === null)
    .map((intent) => intent.id);
}

/**
 * Fills detail fields the log did not carry from the contract's stored intent. Status, reason, results and
 * transaction links always come from events, so a stale read never overrides newer events.
 */
export function mergeIntentDetails(view: IntentView, stored: Intent): IntentView {
  if (stored.id !== view.id) throw new RangeError(`intent ${stored.id} does not match view ${view.id}`);
  const merged: IntentView = {
    ...view,
    market: view.market ?? stored.market,
    category: view.category ?? stored.category,
    outcome: view.outcome ?? stored.outcome,
    isBuy: view.isBuy ?? stored.isBuy,
    amountCents: view.amountCents ?? stored.amountCents,
    limitPrice: view.limitPrice ?? stored.limitPrice,
    proposedAt: stored.proposedAt,
  };
  // Carry over only the stored flags for fields the view took from storage.
  const fromStorage = pick(stored.outOfRange, [
    ...(view.amountCents === null ? ["amountCents"] : []),
    ...(view.limitPrice === null ? ["limitPrice"] : []),
  ]);
  return withOutOfRange(merged, fromStorage);
}

/** Whether any number of the intent is out of range on chain. */
export function hasOutOfRange(intent: { outOfRange?: OutOfRange | undefined }): boolean {
  return intent.outOfRange !== undefined && Object.keys(intent.outOfRange).length > 0;
}

function pick(source: OutOfRange | undefined, fields: readonly string[]): OutOfRange | undefined {
  if (source === undefined) return undefined;
  const picked = Object.fromEntries(fields.flatMap((f) => (source[f] === undefined ? [] : [[f, source[f]]])));
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** `view` with `extra` flags added to its own, keeping the record free of an empty `outOfRange`. */
function withOutOfRange(view: IntentView, extra: OutOfRange | undefined): IntentView {
  if (extra === undefined || Object.keys(extra).length === 0) return view;
  return { ...view, outOfRange: { ...view.outOfRange, ...extra } };
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

function blankIntent(id: number, event: PolicyEvent): IntentView {
  return {
    id,
    status: "none",
    reason: null,
    market: null,
    category: null,
    outcome: null,
    isBuy: null,
    amountCents: null,
    limitPrice: null,
    agent: null,
    contextHash: null,
    proposedAt: event.blockTimestamp,
    filledCents: null,
    pnlCents: null,
    proposedTxHash: event.transactionHash,
    decidedTxHash: null,
    resultTxHash: null,
  };
}

/** Applies one event in place. Only called on a fresh copy. Intent records are replaced, never mutated. */
function step(state: PolicyViewState, event: PolicyEvent): void {
  /** Creates the intent on its first event, then merges `patch` into a new record. */
  const update = (id: number, patch: Partial<IntentView>): void => {
    let existing = state.intents[id];
    if (!existing) {
      existing = blankIntent(id, event);
      state.counts.proposed += 1;
    }
    const flags = "outOfRange" in event ? event.outOfRange : undefined;
    state.intents[id] = withOutOfRange({ ...existing, ...patch }, flags);
  };

  switch (event.type) {
    case "PolicyUpdated":
      state.rules = { ...event.rules };
      state.paused = event.rules.paused;
      return;

    case "Paused":
      state.paused = event.paused;
      if (state.rules) state.rules = { ...state.rules, paused: event.paused };
      return;

    case "IntentProposed":
      update(event.intentId, {
        market: event.market,
        category: event.category,
        outcome: event.outcome,
        isBuy: event.isBuy,
        amountCents: event.amountCents,
        limitPrice: event.limitPrice,
        agent: event.agent,
        contextHash: event.contextHash,
      });
      return;

    case "IntentNeedsApproval":
      state.counts.needsApproval += 1;
      update(event.intentId, { status: "needs_approval", amountCents: event.amountCents });
      return;

    case "IntentApproved":
      state.counts.approved += 1;
      // An approved amount is at most the max trade size, so it fits whenever the rules do; a null amount
      // cannot be added exactly, and is left out rather than approximated.
      if (event.isBuy && event.amountCents !== null) {
        state.committedCents += event.amountCents;
        state.openBuyAmounts[event.intentId] = event.amountCents;
      }
      update(event.intentId, {
        status: "approved",
        market: event.market,
        outcome: event.outcome,
        isBuy: event.isBuy,
        amountCents: event.amountCents,
        limitPrice: event.limitPrice,
        decidedTxHash: event.transactionHash,
      });
      return;

    case "IntentRejected":
      state.counts.rejected += 1;
      state.rejectionsByReason[event.reason] = (state.rejectionsByReason[event.reason] ?? 0) + 1;
      update(event.intentId, {
        status: "rejected",
        reason: event.reason,
        decidedTxHash: event.transactionHash,
      });
      return;

    case "ResultRecorded": {
      if (event.filled) state.counts.executed += 1;
      else state.counts.failed += 1;

      // The contract caps a fill at the intent's amount, so `filledCents` fits whenever the amount did.
      // Profit and loss is whatever the executor key sent; an out-of-range one is flagged on the intent
      // and left out of the totals rather than approximated.
      const openBuy = state.openBuyAmounts[event.intentId];
      if (openBuy !== undefined && event.filledCents !== null) {
        state.committedCents -= openBuy - event.filledCents;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- record keyed by intent id
        delete state.openBuyAmounts[event.intentId];
      }
      if (event.pnlCents !== null) {
        state.realizedPnlCents += event.pnlCents;
        if (event.pnlCents < 0) {
          const day = utcDay(event.blockTimestamp);
          state.lossByDay[day] = (state.lossByDay[day] ?? 0) - event.pnlCents;
        }
      }
      update(event.intentId, {
        status: event.filled ? "executed" : "failed",
        filledCents: event.filledCents,
        pnlCents: event.pnlCents,
        resultTxHash: event.transactionHash,
      });
      return;
    }
  }
}
