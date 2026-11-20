/**
 * The public dashboard of the contract's agent (issue #38): every number read from the Policy
 * contract's events, each with the transactions behind it so anyone can check it onchain.
 *
 * It is built from the chain, plus one offchain record: what filled positions paid when their markets
 * resolved (issue #92), which the contract cannot hold. Those come only as totals of records signed by the
 * contract's executor and still matching their hash, and the page labels them as offchain. Nothing else
 * offchain (holdings, plans, sealed reasons, payments) goes in, so the public page cannot leak it. Lists are capped, so the page is the
 * same size however long the history grows. The numbers agree with the audit trail by construction of
 * the same rules, and a test holds them to it.
 */
import {
  type IntentStatus,
  type PolicyEvent,
  type PolicyRules,
  type SettlementTotals,
  describeReason,
  intentAnomalies,
  settlementTotals,
} from "@mandate/shared";
import type { Address, Hex } from "viem";

import type { ChainView } from "@/lib/live/types";
import { clip } from "@/lib/text";

/** Transactions listed under each number, newest first; the rest are in the contract's event log. */
export const PROOF_LIMIT = 10;
/** Intents in the recent verdicts table. */
export const RECENT_LIMIT = 20;
/** Onchain strings are untrusted and can be huge: reasons are clipped to this before they reach the page. */
const MAX_REASON = 64;

/** One event behind a number: its transaction, block and time (unix seconds). */
export interface Proof {
  txHash: Hex;
  blockNumber: number;
  at: number;
  intentId: number | null;
}

export interface Counted {
  count: number;
  /** The newest `PROOF_LIMIT` events behind the count, newest first. */
  proofs: Proof[];
}

export interface BlockedRule extends Counted {
  /** The contract's reason string, clipped. */
  reason: string;
  label: string;
}

export interface RecentIntent {
  id: number;
  /**
   * The onchain market, for `MarketName`, which shows a Gemini symbol and never prints anything else
   * raw. Null when no event carried it.
   */
  market: string | null;
  category: number | null;
  /** Null when no event carried it, or when it is out of range (`amountOutOfRange`). */
  amountCents: number | null;
  amountOutOfRange: boolean;
  /** Why the agent's MCP server could not have sent it, each describing a value without quoting it. */
  flags: string[];
  status: IntentStatus;
  reason: string | null;
  proposedAt: number;
  txHash: Hex;
}

export interface PublicDashboard {
  /** The newest block the numbers include. */
  asOf: { blockNumber: number; timestamp: number };
  mandate: {
    version: number;
    rules: PolicyRules | null;
    paused: boolean;
    /** The `PolicyUpdated` of the rules in force. */
    setBy: Proof | null;
  };
  /** Intents the agent proposed: one per intent id seen. */
  proposed: Counted;
  /** The contract's verdict in each proposal's own transaction. */
  atProposal: { approved: Counted; held: Counted; rejected: Counted };
  /** Every rejection but the owner's own, by the contract's reason, most frequent first. */
  blocked: BlockedRule[];
  blockedTotal: number;
  /** The owner's answers to held intents, in later transactions. */
  owner: { approvals: Counted; rejections: Counted; waiting: number };
  fills: {
    filled: Counted;
    notFilled: Counted;
    /** Sums over fills whose amounts fit offchain numbers. */
    filledCents: number;
    /**
     * The results the executor recorded onchain with the fills. Not a result: the contract records 0 at
     * every fill because it cannot record the settlement (contract request 2.4); `settled` holds the results.
     */
    recordedPnlCents: number;
    /** Fills whose filled amount or result is out of range: counted, but left out of the sums. */
    outOfRange: number;
    /** Approved intents the executor has not reported on yet. */
    open: number;
  };
  /**
   * Filled positions whose market resolved, as the executor signed them: offchain, because the contract
   * cannot record a payout. `paidOut` counts the positions that paid anything.
   */
  settled: SettlementTotals & { paidOut: number };
  recent: RecentIntent[];
}

const OWNER_REJECTION = "rejected by user";

class Tally {
  count = 0;
  private readonly newest: Proof[] = [];

  add(event: PolicyEvent): void {
    this.count += 1;
    this.newest.push(proof(event));
    if (this.newest.length > PROOF_LIMIT) this.newest.shift();
  }

  done(): Counted {
    return { count: this.count, proofs: [...this.newest].reverse() };
  }
}

function proof(event: PolicyEvent): Proof {
  return {
    txHash: event.transactionHash,
    blockNumber: event.blockNumber,
    at: event.blockTimestamp,
    intentId: "intentId" in event ? event.intentId : null,
  };
}

export function buildPublicDashboard(
  chain: Pick<ChainView, "events" | "intents" | "head" | "rules" | "paused" | "settlements">,
): PublicDashboard {
  const firstTx = new Map<number, string>();
  const proposed = new Tally();
  const approved = new Tally();
  const held = new Tally();
  const rejected = new Tally();
  const approvals = new Tally();
  const rejections = new Tally();
  const filled = new Tally();
  const notFilled = new Tally();
  const blocked = new Map<string, Tally>();
  let version = 0;
  let setBy: Proof | null = null;
  let filledCents = 0;
  let recordedPnlCents = 0;
  let fillsOutOfRange = 0;

  for (const event of chain.events) {
    if (event.type === "PolicyUpdated") {
      version += 1;
      setBy = proof(event);
      continue;
    }
    if (!("intentId" in event)) continue;
    const tx = event.transactionHash.toLowerCase();
    let first = firstTx.get(event.intentId);
    if (first === undefined) {
      first = tx;
      firstTx.set(event.intentId, tx);
      proposed.add(event);
    }
    const atProposal = first === tx;
    switch (event.type) {
      case "IntentApproved":
        (atProposal ? approved : approvals).add(event);
        break;
      case "IntentNeedsApproval":
        held.add(event);
        break;
      case "IntentRejected": {
        if (event.reason === OWNER_REJECTION) {
          rejections.add(event);
          break;
        }
        if (atProposal) rejected.add(event);
        const reason = clip(event.reason, MAX_REASON);
        const tally = blocked.get(reason) ?? new Tally();
        tally.add(event);
        blocked.set(reason, tally);
        break;
      }
      case "ResultRecorded":
        if (event.filled) {
          filled.add(event);
          if (event.filledCents === null || event.pnlCents === null) {
            fillsOutOfRange += 1;
          } else {
            filledCents += event.filledCents;
            recordedPnlCents += event.pnlCents;
          }
        } else {
          notFilled.add(event);
        }
        break;
      default:
        break;
    }
  }

  const rules = [...blocked]
    .map(([reason, tally]): BlockedRule => ({ reason, label: describeReason(reason).label, ...tally.done() }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const recent = [...chain.intents]
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((intent): RecentIntent => {
      return {
        id: intent.id,
        market: intent.market,
        category: intent.category,
        amountCents: intent.amountCents,
        amountOutOfRange: intent.outOfRange?.["amountCents"] !== undefined,
        flags: intentAnomalies(intent).map((anomaly) => anomaly.text),
        status: intent.status,
        reason: intent.reason === null ? null : clip(intent.reason, MAX_REASON),
        proposedAt: intent.proposedAt,
        txHash: intent.decidedTxHash ?? intent.proposedTxHash,
      };
    });

  return {
    asOf: chain.head,
    mandate: { version, rules: chain.rules, paused: chain.paused, setBy },
    proposed: proposed.done(),
    atProposal: { approved: approved.done(), held: held.done(), rejected: rejected.done() },
    blocked: rules,
    blockedTotal: rules.reduce((sum, rule) => sum + rule.count, 0),
    owner: {
      approvals: approvals.done(),
      rejections: rejections.done(),
      waiting: chain.intents.filter((intent) => intent.status === "needs_approval").length,
    },
    fills: {
      filled: filled.done(),
      notFilled: notFilled.done(),
      filledCents,
      recordedPnlCents,
      outOfRange: fillsOutOfRange,
      open: chain.intents.filter((intent) => intent.status === "approved").length,
    },
    settled: settledOutcomes(chain.settlements),
    recent,
  };
}

function settledOutcomes(settlements: ChainView["settlements"]): PublicDashboard["settled"] {
  const docs = Object.values(settlements).flatMap((view) =>
    view.status === "verified" ? [view.document] : [],
  );
  return { ...settlementTotals(docs), paidOut: docs.filter((doc) => doc.payoutCents > 0).length };
}

/** The agent's name as it announced itself, clipped: it is the agent's own string. */
export function publicAgentName(name: string | null, address: Address): string {
  return name ? clip(name, 48) : `Agent ${address.slice(0, 6)}…${address.slice(-4)}`;
}
