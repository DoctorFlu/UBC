/**
 * The evidence chain of one hedge plan (issue #37): the owner's request, the paid signal, the plan, and
 * each intent that carried it out with the contract's verdict, the owner's decision and the fill.
 *
 * The only link the console trusts between an intent and a plan is the agent's sealed reason: a stored
 * decision context that hashes to the intent's sealed hash (`verified`) and names the plan. The chain is
 * "verified" only when every intent in it has such a reason, and each names the plan's paid signal too
 * when the plan was built on one. Everything short of that is shown as it is, never smoothed over:
 * - a reason whose stored document no longer hashes (`tampered`) and claims this plan breaks the chain;
 * - an intent with no checkable reason that matches one of the plan's orders by market and amount
 *   leaves it unproven;
 * - a verified reason that does not name the plan's receipt leaves the signal unlinked;
 * - a plan no intent carried out has nothing to verify yet.
 *
 * Pure, so the view, the tests and any export agree.
 */
import type { IntentView, PolicyEvent } from "@mandate/shared";
import type { Hex } from "viem";

import type { AgentPlanView } from "@/lib/hedge/types";
import type { ChainView } from "@/lib/live/types";
import type { SignalPaymentView } from "@/lib/payments/types";

/** The state of one intent's sealed reason. `none` is an intent with no sealed hash at all. */
export type SealState = "verified" | "tampered" | "not_stored" | "none";

/**
 * Why an intent is in this plan's chain:
 * - `cites`: its verified reason names the plan.
 * - `claims`: its stored reason names the plan but no longer hashes, so the claim proves nothing.
 * - `matches`: it has no reason the console can check, and its market and amount match an order.
 */
export type Attribution = "cites" | "claims" | "matches";

/** A transaction that recorded one step, with its block and the block's time (unix seconds). */
export interface ChainTx {
  txHash: Hex;
  blockNumber: number;
  at: number;
}

export type ContractVerdict =
  | { kind: "approved"; tx: ChainTx }
  | { kind: "held"; tx: ChainTx }
  | { kind: "rejected"; reason: string; tx: ChainTx };

/**
 * What happened to a held intent: the owner approved it, rejected it, or approved it and the contract
 * rejected it on its re-check (for example the budget ran out while it waited).
 */
export type OwnerDecision =
  | { kind: "approved"; tx: ChainTx }
  | { kind: "rejected"; tx: ChainTx }
  | { kind: "rejected_on_approval"; reason: string; tx: ChainTx };

export interface FillRecord {
  filled: boolean;
  filledCents: number;
  pnlCents: number;
  tx: ChainTx;
}

export interface ChainIntent {
  intent: IntentView;
  attribution: Attribution;
  seal: SealState;
  /** Whether the reason names the plan's paid signal; null when the plan has none or the reason is unreadable. */
  namesReceipt: boolean | null;
  /** The plan order it carries out, by index, or null when it matches none (a re-sized retry, say). */
  orderIndex: number | null;
  /** The transaction that proposed it: its `IntentProposed`, or the verdict's on a contract without one. */
  proposed: ChainTx;
  verdict: ContractVerdict | null;
  owner: OwnerDecision | null;
  fill: FillRecord | null;
}

/**
 * - `verified`: every intent's reason hashes to its record and names the plan (and its signal).
 * - `tampered`: at least one stored reason claiming the plan no longer hashes.
 * - `not_stored`: at least one intent matching an order has no reason the console can check.
 * - `signal_unlinked`: every reason checks out, but at least one does not name the plan's paid signal.
 * - `not_executed`: no intent carried the plan out, so there is nothing to verify yet.
 */
export type ChainStatus = "verified" | "tampered" | "not_stored" | "signal_unlinked" | "not_executed";

export interface EvidenceChain {
  status: ChainStatus;
  /** The receipt id of the plan's paid signal, lower case, or null when the plan used none. */
  receiptId: string | null;
  /** The payment behind that receipt, as the agent reported it, or null when it never did. */
  payment: SignalPaymentView | null;
  /** Intents in the chain, in id order. */
  intents: ChainIntent[];
  /** Indexes of the plan's orders no intent carried out. */
  unproposed: number[];
  /** What is missing or wrong, one plain sentence each, most serious first. Empty when nothing is. */
  gaps: string[];
}

const plural = (count: number, one: string, many: string) =>
  `${count.toString()} ${count === 1 ? one : many}`;

function txOf(event: PolicyEvent): ChainTx {
  return { txHash: event.transactionHash, blockNumber: event.blockNumber, at: event.blockTimestamp };
}

const sameTx = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The steps of one intent, read from its events in chain order. */
function stepsOf(
  intent: IntentView,
  events: readonly PolicyEvent[],
): Pick<ChainIntent, "proposed" | "verdict" | "owner" | "fill"> {
  const first = events[0];
  const proposedEvent = events.find((event) => event.type === "IntentProposed") ?? first;
  const proposed: ChainTx = proposedEvent
    ? txOf(proposedEvent)
    : { txHash: intent.proposedTxHash, blockNumber: 0, at: intent.proposedAt };
  let verdict: ContractVerdict | null = null;
  let owner: OwnerDecision | null = null;
  let fill: FillRecord | null = null;
  for (const event of events) {
    const atProposal = sameTx(event.transactionHash, proposed.txHash);
    switch (event.type) {
      case "IntentApproved":
        if (atProposal) verdict = { kind: "approved", tx: txOf(event) };
        else owner = { kind: "approved", tx: txOf(event) };
        break;
      case "IntentNeedsApproval":
        if (atProposal) verdict = { kind: "held", tx: txOf(event) };
        break;
      case "IntentRejected":
        if (atProposal) verdict = { kind: "rejected", reason: event.reason, tx: txOf(event) };
        else if (event.reason === "rejected by user") owner = { kind: "rejected", tx: txOf(event) };
        else owner = { kind: "rejected_on_approval", reason: event.reason, tx: txOf(event) };
        break;
      case "ResultRecorded":
        fill = {
          filled: event.filled,
          filledCents: event.filledCents,
          pnlCents: event.pnlCents,
          tx: txOf(event),
        };
        break;
      default:
        break;
    }
  }
  return { proposed, verdict, owner, fill };
}

/** Every intent's events in chain order, in one pass over the log. */
function eventsByIntent(events: readonly PolicyEvent[]): Map<number, PolicyEvent[]> {
  const byIntent = new Map<number, PolicyEvent[]>();
  for (const event of events) {
    if (!("intentId" in event)) continue;
    const list = byIntent.get(event.intentId);
    if (list) list.push(event);
    else byIntent.set(event.intentId, [event]);
  }
  return byIntent;
}

export function evidenceChain(
  view: Pick<AgentPlanView, "planId" | "plan">,
  chain: Pick<ChainView, "intents" | "events" | "sealed"> | null,
  payments: readonly SignalPaymentView[],
): EvidenceChain {
  const { plan, planId } = view;
  const receiptId = plan.signal?.receiptId.toLowerCase() ?? null;
  const payment =
    receiptId === null ? null : (payments.find((candidate) => candidate.receiptId === receiptId) ?? null);
  const intents = chain?.intents ?? [];
  const sealed = chain?.sealed ?? {};

  // Which intents belong to the plan, before any order is matched.
  const named: {
    intent: IntentView;
    attribution: Attribution;
    seal: SealState;
    receipts: string[] | null;
  }[] = [];
  const unchecked: IntentView[] = [];
  for (const intent of intents) {
    const reason = sealed[intent.id];
    if (reason?.status === "verified") {
      if (reason.document.planId === planId) {
        named.push({
          intent,
          attribution: "cites",
          seal: "verified",
          receipts: reason.document.signalReceiptIds,
        });
      }
    } else if (reason?.status === "tampered") {
      if (reason.claims.planId === planId) {
        named.push({ intent, attribution: "claims", seal: "tampered", receipts: null });
      }
    } else {
      unchecked.push(intent);
    }
  }

  // Orders are matched by market and amount, each intent and each order once: named intents first.
  const taken = new Set<number>();
  const matchOrder = (intent: IntentView): number | null => {
    const index = plan.orders.findIndex(
      (order, at) =>
        !taken.has(at) &&
        order.instrumentSymbol === intent.market &&
        order.amountCents === intent.amountCents,
    );
    if (index < 0) return null;
    taken.add(index);
    return index;
  };
  const members: Omit<ChainIntent, "proposed" | "verdict" | "owner" | "fill">[] = named.map((entry) => ({
    intent: entry.intent,
    attribution: entry.attribution,
    seal: entry.seal,
    namesReceipt:
      receiptId === null || entry.receipts === null
        ? null
        : entry.receipts.some((id) => id.toLowerCase() === receiptId),
    orderIndex: matchOrder(entry.intent),
  }));
  for (const intent of unchecked) {
    const orderIndex = matchOrder(intent);
    if (orderIndex === null) continue;
    members.push({
      intent,
      attribution: "matches",
      seal: sealed[intent.id]?.status === "not_stored" ? "not_stored" : "none",
      namesReceipt: null,
      orderIndex,
    });
  }
  members.sort((a, b) => a.intent.id - b.intent.id);

  const byIntent = eventsByIntent(chain?.events ?? []);
  const linked: ChainIntent[] = members.map((member) => ({
    ...member,
    ...stepsOf(member.intent, byIntent.get(member.intent.id) ?? []),
  }));
  const unproposed = plan.orders.map((_, index) => index).filter((index) => !taken.has(index));

  const tampered = linked.filter((entry) => entry.seal === "tampered").length;
  const unproven = linked.filter((entry) => entry.attribution === "matches").length;
  const unlinked = linked.filter((entry) => entry.namesReceipt === false).length;
  const status: ChainStatus =
    linked.length === 0
      ? "not_executed"
      : tampered > 0
        ? "tampered"
        : unproven > 0
          ? "not_stored"
          : unlinked > 0
            ? "signal_unlinked"
            : "verified";

  const gaps: string[] = [];
  if (tampered > 0) {
    gaps.push(
      `${plural(tampered, "intent's stored reason names", "intents' stored reasons name")} this plan but no longer ${tampered === 1 ? "hashes" : "hash"} to the sealed hash: ${tampered === 1 ? "it was" : "they were"} changed after the fact.`,
    );
  }
  if (unproven > 0) {
    gaps.push(
      `${plural(unproven, "intent matches", "intents match")} an order of this plan by market and amount but ${unproven === 1 ? "has" : "have"} no sealed reason the console can check, so ${unproven === 1 ? "it" : "they"} cannot be proven to belong to it.`,
    );
  }
  if (unlinked > 0) {
    gaps.push(
      `${plural(unlinked, "intent's reason does", "intents' reasons do")} not name the paid signal this plan was built on.`,
    );
  }
  if (receiptId !== null && payment === null) {
    gaps.push("The plan names a paid signal, but the agent never reported that payment to the console.");
  }
  if (plan.orders.length === 0) {
    gaps.push("The plan has no orders, so there was nothing to execute.");
  } else if (unproposed.length > 0) {
    gaps.push(
      linked.length === 0
        ? `None of the plan's ${plural(plan.orders.length, "order was", "orders were")} proposed on the chain.`
        : `${plural(unproposed.length, "order", "orders")} of ${plan.orders.length.toString()} ${unproposed.length === 1 ? "was" : "were"} never proposed.`,
    );
  }
  return { status, receiptId, payment, intents: linked, unproposed, gaps };
}

/** The chain's state in one sentence, for the top of the view. */
export function chainHeadline(evidence: Pick<EvidenceChain, "status" | "receiptId" | "intents">): string {
  const count = evidence.intents.length;
  switch (evidence.status) {
    case "verified":
      return `Verified: ${count === 1 ? "the intent's" : `all ${count.toString()} intents'`} sealed ${count === 1 ? "reason hashes" : "reasons hash"} to the chain and ${count === 1 ? "names" : "name"} this plan${evidence.receiptId === null ? "" : " and its paid signal"}.`;
    case "tampered":
      return "Broken: a stored reason for this plan was changed after it was sealed.";
    case "not_stored":
      return "Unproven: an intent that looks like part of this plan has no reason the console can check.";
    case "signal_unlinked":
      return "Unproven: every reason checks out, but not every one names the paid signal the plan used.";
    case "not_executed":
      return "Nothing to verify yet: no intent on the chain carries out this plan.";
  }
}

/** The evidence page of a plan. Plan ids are the agent's own strings, so they are encoded. */
export function evidenceHref(planId: string): string {
  return `/hedge/plans/${encodeURIComponent(planId)}`;
}
