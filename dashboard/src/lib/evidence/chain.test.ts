import { type DecisionContext, type PolicyEvent, reduceEvents } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { fixtureContext, fixtureRules } from "@/fixtures";
import { sampleHedgePlan } from "@/fixtures/samples";
import { buildChainView } from "@/lib/live/chain-view";
import type { ChainView, SealedReason } from "@/lib/live/types";
import type { SignalPaymentView } from "@/lib/payments/types";

import { chainHeadline, evidenceChain, evidenceHref } from "./chain";
import { readClaims } from "./claims";

const RECEIPT = `0x${"7c".repeat(32)}`;
const OTHER_RECEIPT = `0x${"9d".repeat(32)}`;
const plan = {
  ...sampleHedgePlan,
  signal: { ...signalUse(), receiptId: RECEIPT.toUpperCase().replace("0X", "0x") },
};
// The test chain's blocks start at 2026-11-15T13:20:11Z: the plan is made just before.
const made = { createdAt: "2026-11-15T13:19:00.000Z", storedAt: "2026-11-15T13:19:01.000Z" };
const view = { planId: plan.planId, plan, ...made };
const unsignedView = {
  planId: sampleHedgePlan.planId,
  plan: { ...sampleHedgePlan, signal: undefined },
  ...made,
};

function signalUse() {
  return {
    receiptId: RECEIPT,
    signalId: `0x${"4e".repeat(32)}`,
    used: true,
    ignoredBecause: null,
    buyOrder: "signal" as const,
    changedOrders: false,
    rungs: [],
    expensiveBoughtStrikesCents: [],
  };
}

const payment: SignalPaymentView = {
  receiptId: RECEIPT,
  recordedAt: "2026-11-15T13:20:00.000Z",
  amount: "1000",
  paidAt: "2026-11-15T13:19:58.000Z",
  resource: "/v1/signal/hedge?asset=BTC&horizon=weekly",
  network: "eip155:5042002",
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  payee: null,
  settlementId: "gw-1",
  signal: null,
};

const orders = plan.orders;
const order = (index: number) => {
  const found = orders[index];
  if (!found) throw new Error(`the sample plan has no order ${index.toString()}`);
  return found;
};

/** A chain where each listed intent proposes `market` for `amountCents`, with the given follow-ups. */
function chainOf(
  intents: {
    market: string;
    amountCents: number;
    then?: ("approve" | "hold" | "owner_approves" | "owner_rejects" | "fill" | "reject")[];
  }[],
  sealed: Record<number, SealedReason> = {},
): ChainView {
  const events: PolicyEvent[] = [];
  let block = 10;
  const tx = (): Pick<PolicyEvent, "blockNumber" | "blockTimestamp" | "transactionHash"> => {
    block += 1;
    return {
      blockNumber: block,
      blockTimestamp: 1_794_748_800 + block,
      transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    };
  };
  events.push({ ...tx(), logIndex: 0, type: "PolicyUpdated", rules: fixtureRules });
  intents.forEach((spec, intentId) => {
    const meta = tx();
    const order = {
      market: spec.market,
      outcome: "NO",
      isBuy: true,
      amountCents: spec.amountCents,
      limitPrice: 30,
    };
    events.push({
      ...meta,
      logIndex: 0,
      type: "IntentProposed",
      intentId,
      agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      category: 1,
      contextHash: `0x${"00".repeat(32)}`,
      ...order,
    });
    for (const step of spec.then ?? ["approve"]) {
      if (step === "approve")
        events.push({ ...meta, logIndex: 1, type: "IntentApproved", intentId, ...order });
      if (step === "reject") {
        events.push({
          ...meta,
          logIndex: 1,
          type: "IntentRejected",
          intentId,
          reason: "over max trade size",
        });
      }
      if (step === "hold") {
        events.push({
          ...meta,
          logIndex: 1,
          type: "IntentNeedsApproval",
          intentId,
          amountCents: spec.amountCents,
        });
      }
      if (step === "owner_approves")
        events.push({ ...tx(), logIndex: 0, type: "IntentApproved", intentId, ...order });
      if (step === "owner_rejects") {
        events.push({ ...tx(), logIndex: 0, type: "IntentRejected", intentId, reason: "rejected by user" });
      }
      if (step === "fill") {
        events.push({
          ...tx(),
          logIndex: 0,
          type: "ResultRecorded",
          intentId,
          filled: true,
          filledCents: spec.amountCents,
          pnlCents: -40,
        });
      }
    }
  });
  return buildChainView(
    reduceEvents(events),
    { blockNumber: block, timestamp: 1_794_748_800 + block },
    new Map(),
    sealed,
  );
}

function verified(planId: string, receipts: string[] = [RECEIPT]): SealedReason {
  const document: DecisionContext = { ...fixtureContext, planId, signalReceiptIds: receipts };
  return {
    status: "verified",
    source: "onchain",
    hash: `0x${"11".repeat(32)}`,
    document,
    storedAt: "2026-11-15T13:30:00.000Z",
  };
}

describe("evidenceChain", () => {
  it("verifies a chain whose every intent's reason names the plan and its receipt, step by step", () => {
    const chain = chainOf(
      [
        { market: order(0).instrumentSymbol, amountCents: order(0).amountCents, then: ["approve", "fill"] },
        {
          market: order(1).instrumentSymbol,
          amountCents: order(1).amountCents,
          then: ["hold", "owner_approves"],
        },
      ],
      { 0: verified(plan.planId), 1: verified(plan.planId) },
    );
    const evidence = evidenceChain(view, chain, [payment]);
    expect(evidence.status).toBe("verified");
    expect(evidence.payment).toBe(payment);
    expect(evidence.receiptId).toBe(RECEIPT);
    expect(
      evidence.intents.map((entry) => [entry.attribution, entry.seal, entry.namesReceipt, entry.orderIndex]),
    ).toEqual([
      ["cites", "verified", true, 0],
      ["cites", "verified", true, 1],
    ]);
    const [first, second] = evidence.intents;
    expect(first?.verdict?.kind).toBe("approved");
    expect(first?.verdict?.tx.txHash).toBe(first?.proposed.txHash);
    expect(first?.owner).toBeNull();
    expect(first?.fill).toMatchObject({ filled: true, filledCents: order(0).amountCents });
    expect(second?.verdict?.kind).toBe("held");
    expect(second?.owner?.kind).toBe("approved");
    expect(second?.owner?.tx.txHash).not.toBe(second?.proposed.txHash);
    expect(second?.fill).toBeNull();
    expect(evidence.unproposed).toEqual(orders.slice(2).map((_, index) => index + 2));
    expect(evidence.gaps).toEqual([
      `${(orders.length - 2).toString()} orders of ${orders.length.toString()} were never proposed.`,
    ]);
    expect(chainHeadline(evidence)).toBe(
      "Verified: all 2 intents' sealed reasons hash to the chain and name this plan and its paid signal.",
    );
  });

  it("says a plan nobody carried out has nothing to verify, and that its signal payment is missing", () => {
    const evidence = evidenceChain(view, chainOf([]), []);
    expect(evidence.status).toBe("not_executed");
    expect(evidence.intents).toEqual([]);
    expect(evidence.gaps).toEqual([
      "The plan names a paid signal, but the agent never reported that payment to the console.",
      `None of the plan's ${orders.length.toString()} orders were proposed on the chain.`,
    ]);
    expect(chainHeadline(evidence)).toBe(
      "Nothing to verify yet: no intent on the chain carries out this plan.",
    );
  });

  it("verifies a plan without a paid signal on its plan id alone", () => {
    const chain = chainOf([{ market: order(0).instrumentSymbol, amountCents: order(0).amountCents }], {
      0: verified(unsignedView.planId, []),
    });
    const evidence = evidenceChain(unsignedView, chain, [payment]);
    expect(evidence.status).toBe("verified");
    expect(evidence.receiptId).toBeNull();
    expect(evidence.payment).toBeNull();
    expect(evidence.intents[0]?.namesReceipt).toBeNull();
  });

  it("breaks on a tampered reason that claims the plan, even when the rest check out", () => {
    const chain = chainOf(
      [
        { market: order(0).instrumentSymbol, amountCents: order(0).amountCents },
        { market: order(1).instrumentSymbol, amountCents: order(1).amountCents },
      ],
      {
        0: verified(plan.planId),
        1: {
          status: "tampered",
          source: "offchain",
          hash: `0x${"22".repeat(32)}`,
          storedAt: "2026-11-15T13:30:00.000Z",
          claims: { planId: plan.planId, signalReceiptIds: [RECEIPT] },
        },
      },
    );
    const evidence = evidenceChain(view, chain, [payment]);
    expect(evidence.status).toBe("tampered");
    expect(evidence.intents.map((entry) => [entry.attribution, entry.seal])).toEqual([
      ["cites", "verified"],
      ["claims", "tampered"],
    ]);
    expect(evidence.gaps[0]).toBe(
      "1 intent's stored reason names this plan but no longer hashes to the sealed hash: it was changed after the fact.",
    );
  });

  it("leaves a chain unproven when an intent matching an order has no checkable reason", () => {
    const chain = chainOf(
      [
        { market: order(0).instrumentSymbol, amountCents: order(0).amountCents },
        { market: order(1).instrumentSymbol, amountCents: order(1).amountCents },
        // The same market for another amount matches no order: not part of this plan.
        { market: order(2).instrumentSymbol, amountCents: order(2).amountCents + 1 },
      ],
      {
        0: verified(plan.planId),
        1: { status: "not_stored", source: "onchain", hash: `0x${"33".repeat(32)}` },
      },
    );
    const evidence = evidenceChain(view, chain, [payment]);
    expect(evidence.status).toBe("not_stored");
    expect(evidence.intents.map((entry) => [entry.intent.id, entry.attribution, entry.seal])).toEqual([
      [0, "cites", "verified"],
      [1, "matches", "not_stored"],
    ]);
    expect(evidence.gaps[0]).toBe(
      "1 intent matches an order of this plan by market and amount but has no sealed reason the console can check, so it cannot be proven to belong to it.",
    );
  });

  it("does not take an intent whose verified reason names another plan, whatever it matches", () => {
    const chain = chainOf([{ market: order(0).instrumentSymbol, amountCents: order(0).amountCents }], {
      0: verified("plan_someone_else"),
    });
    expect(evidenceChain(view, chain, [payment]).intents).toEqual([]);
  });

  it("does not take an unsealed intent proposed before the plan was made, however well it matches", () => {
    const chain = chainOf([{ market: order(0).instrumentSymbol, amountCents: order(0).amountCents }]);
    const later = { ...view, createdAt: "2026-11-15T14:00:00.000Z", storedAt: "2026-11-15T14:00:01.000Z" };
    const evidence = evidenceChain(later, chain, [payment]);
    expect(evidence.intents).toEqual([]);
    expect(evidence.status).toBe("not_executed");
    // A wrong clock on one side never hides an intent: the earlier of the two times counts.
    const skewed = { ...later, createdAt: "2026-11-15T13:00:00.000Z" };
    expect(evidenceChain(skewed, chain, [payment]).intents).toHaveLength(1);
  });

  it("flags reasons that do not name the plan's paid signal", () => {
    const chain = chainOf([{ market: order(0).instrumentSymbol, amountCents: order(0).amountCents }], {
      0: verified(plan.planId, [OTHER_RECEIPT]),
    });
    const evidence = evidenceChain(view, chain, [payment]);
    expect(evidence.status).toBe("signal_unlinked");
    expect(evidence.intents[0]?.namesReceipt).toBe(false);
    expect(evidence.gaps[0]).toBe("1 intent's reason does not name the paid signal this plan was built on.");
  });

  it("tells the owner's rejection from the contract's verdict, and a re-check that failed", () => {
    const chain = chainOf(
      [
        {
          market: order(0).instrumentSymbol,
          amountCents: order(0).amountCents,
          then: ["hold", "owner_rejects"],
        },
        { market: order(1).instrumentSymbol, amountCents: order(1).amountCents, then: ["reject"] },
      ],
      { 0: verified(plan.planId), 1: verified(plan.planId) },
    );
    const [held, rejected] = evidenceChain(view, chain, [payment]).intents;
    expect(held?.verdict?.kind).toBe("held");
    expect(held?.owner?.kind).toBe("rejected");
    expect(rejected?.verdict).toMatchObject({ kind: "rejected", reason: "over max trade size" });
    expect(rejected?.owner).toBeNull();
  });
});

describe("readClaims", () => {
  it("reads the plan and receipts a document names without trusting its shape", () => {
    expect(readClaims({ planId: "plan_1", signalReceiptIds: [RECEIPT, 7, "x".repeat(200)] })).toEqual({
      planId: "plan_1",
      signalReceiptIds: [RECEIPT],
    });
    expect(readClaims(null)).toEqual({ planId: null, signalReceiptIds: [] });
    expect(readClaims(["plan_1"])).toEqual({ planId: null, signalReceiptIds: [] });
    expect(readClaims({ planId: "p".repeat(16_384) })).toEqual({ planId: null, signalReceiptIds: [] });
  });
});

describe("evidenceHref", () => {
  it("encodes the agent's plan id", () => {
    expect(evidenceHref("plan_1")).toBe("/hedge/plans/plan_1");
    expect(evidenceHref("a/b?c#d")).toBe("/hedge/plans/a%2Fb%3Fc%23d");
  });
});
