import { type PolicyEvent, type Settlement, reduceEvents } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { auditRows, blockedByRule } from "@/features/audit/audit-rows";
import { fixtureContext, fixtureRules, fixtureSnapshot } from "@/fixtures";
import { buildChainView } from "@/lib/live/chain-view";
import type { ChainView } from "@/lib/live/types";

import { PROOF_LIMIT, RECENT_LIMIT, buildScorecard, publicAgentName } from "./scorecard";

const fixture = fixtureSnapshot.chain;
if (!fixture) throw new Error("the fixture snapshot has a chain");

/** The scorecard's numbers, recounted from the audit trail's rows. */
function fromAudit(chain: Pick<ChainView, "events" | "intents">) {
  const rows = auditRows(chain);
  const count = (keep: (row: (typeof rows)[number]) => boolean) => rows.filter(keep).length;
  return {
    version: count((row) => row.group === "mandate"),
    proposed: new Set(rows.flatMap((row) => (row.intentId === null ? [] : [row.intentId]))).size,
    approved: count((row) => row.event === "IntentApproved" && row.group === "verdict"),
    held: count((row) => row.event === "IntentNeedsApproval"),
    rejected: count((row) => row.event === "IntentRejected" && row.group === "verdict"),
    approvals: count((row) => row.label === "Approved by owner"),
    rejections: count((row) => row.label === "Rejected by owner"),
    filled: count((row) => row.label === "Fill recorded"),
    notFilled: count((row) => row.label === "No fill recorded"),
    blocked: blockedByRule(rows).filter(([reason]) => reason !== "rejected by user"),
  };
}

function numbers(chain: ChainView) {
  const card = buildScorecard(chain);
  return {
    version: card.mandate.version,
    proposed: card.proposed.count,
    approved: card.atProposal.approved.count,
    held: card.atProposal.held.count,
    rejected: card.atProposal.rejected.count,
    approvals: card.owner.approvals.count,
    rejections: card.owner.rejections.count,
    filled: card.fills.filled.count,
    notFilled: card.fills.notFilled.count,
    blocked: card.blocked.map((rule) => [rule.reason, rule.count]),
  };
}

/** A long history with every path through the contract, including a re-check that fails on approval. */
function longHistory(intents: number): ChainView {
  const events: PolicyEvent[] = [];
  let block = 1;
  const tx = (): Pick<PolicyEvent, "blockNumber" | "blockTimestamp" | "transactionHash"> => {
    block += 1;
    return {
      blockNumber: block,
      blockTimestamp: 1_800_000_000 + block * 12,
      transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    };
  };
  const policy = tx();
  events.push(
    { ...policy, logIndex: 0, type: "PolicyUpdated", rules: fixtureRules },
    { ...policy, logIndex: 1, type: "Paused", paused: false },
  );
  for (let intentId = 0; intentId < intents; intentId += 1) {
    const order = {
      market: "GEMI-BTC2611202200-HI65000",
      outcome: "NO",
      isBuy: true,
      amountCents: 500,
      limitPrice: 31,
    };
    const meta = tx();
    switch (intentId % 6) {
      case 0:
        events.push({ ...meta, logIndex: 0, type: "IntentApproved", intentId, ...order });
        events.push({
          ...tx(),
          logIndex: 0,
          type: "ResultRecorded",
          intentId,
          filled: true,
          filledCents: 500,
          pnlCents: -20,
        });
        break;
      case 1:
        events.push({ ...meta, logIndex: 0, type: "IntentApproved", intentId, ...order });
        events.push({
          ...tx(),
          logIndex: 0,
          type: "ResultRecorded",
          intentId,
          filled: false,
          filledCents: 0,
          pnlCents: 0,
        });
        break;
      case 2:
        events.push({ ...meta, logIndex: 0, type: "IntentNeedsApproval", intentId, amountCents: 2_400 });
        events.push({ ...tx(), logIndex: 0, type: "IntentApproved", intentId, ...order, amountCents: 2_400 });
        break;
      case 3:
        events.push({ ...meta, logIndex: 0, type: "IntentNeedsApproval", intentId, amountCents: 2_400 });
        events.push({ ...tx(), logIndex: 0, type: "IntentRejected", intentId, reason: "rejected by user" });
        break;
      case 4:
        events.push({
          ...meta,
          logIndex: 0,
          type: "IntentRejected",
          intentId,
          reason: "over max trade size",
        });
        break;
      default:
        events.push({ ...meta, logIndex: 0, type: "IntentNeedsApproval", intentId, amountCents: 2_400 });
        events.push({ ...tx(), logIndex: 0, type: "IntentRejected", intentId, reason: "over budget" });
    }
  }
  return buildChainView(reduceEvents(events), { blockNumber: block, timestamp: 1_800_000_000 + block * 12 });
}

describe("buildScorecard", () => {
  it("counts exactly what the audit trail shows, on the fixture history", () => {
    expect(numbers(fixture)).toEqual(fromAudit(fixture));
  });

  it("counts exactly what the audit trail shows, on a long history with every path", () => {
    const chain = longHistory(60);
    const expected = fromAudit(chain);
    expect(numbers(chain)).toEqual(expected);
    // Re-checks that fail on approval are blocked by rule, not the owner's rejections.
    expect(expected.blocked).toEqual([
      ["over budget", 10],
      ["over max trade size", 10],
    ]);
    expect(expected.rejections).toBe(10);
  });

  it("adds the hedge outcome from the recorded results, as the reducer does", () => {
    const chain = longHistory(60);
    const card = buildScorecard(chain);
    expect(card.fills.recordedPnlCents).toBe(chain.realizedPnlCents);
    expect(card.fills.filledCents).toBe(10 * 500);
    expect(card.proposed.count).toBe(chain.intents.length);
  });

  it("counts a fill whose amounts are out of range, and leaves it out of the totals", () => {
    const chain = longHistory(6);
    const events = chain.events.map((event) =>
      event.type === "ResultRecorded" && event.intentId === 0
        ? {
            ...event,
            filledCents: null,
            pnlCents: null,
            outOfRange: { filledCents: (2n ** 255n).toString() },
          }
        : event,
    );
    const card = buildScorecard({ ...chain, events });
    expect(card.fills.filled.count).toBe(buildScorecard(chain).fills.filled.count);
    expect(card.fills.outOfRange).toBe(1);
    expect(card.fills.filledCents).toBe(buildScorecard(chain).fills.filledCents - 500);
    expect(card.fills.recordedPnlCents).toBe(buildScorecard(chain).fills.recordedPnlCents + 20);
  });

  it("lists the newest transactions behind each number, and no more than the cap", () => {
    const chain = longHistory(60);
    const card = buildScorecard(chain);
    expect(card.proposed.proofs).toHaveLength(PROOF_LIMIT);
    expect(card.proposed.proofs[0]?.intentId).toBe(59);
    const filledTxs = chain.events
      .filter((event) => event.type === "ResultRecorded" && event.filled)
      .map((event) => event.transactionHash)
      .reverse();
    expect(card.fills.filled.proofs.map((entry) => entry.txHash)).toEqual(filledTxs.slice(0, PROOF_LIMIT));
    expect(card.recent).toHaveLength(RECENT_LIMIT);
    expect(card.recent[0]?.id).toBe(59);
    expect(card.mandate.setBy?.txHash).toBe(chain.policySetBy?.txHash);
  });

  it("holds nothing offchain, and flags hostile onchain strings without copying them", () => {
    const huge = `GEMI-${"X".repeat(16_384)}`;
    const chain: ChainView = {
      ...fixture,
      intents: fixture.intents.map((intent, index) => (index === 0 ? { ...intent, market: huge } : intent)),
    };
    const card = buildScorecard(chain);
    // The market is the chain view's own string, for MarketName, which never prints it raw: the rest
    // of the card stays small however large the onchain strings are.
    const json = JSON.stringify(card, (key, value: unknown) => (key === "market" ? undefined : value));
    // The fixture's sealed reasons, plans and payments carry these; none may reach the public page.
    expect(json).not.toContain("plan_3f0c9a1b5e2d7c48");
    expect(json).not.toContain("requestText");
    expect(json).not.toContain("holdings");
    expect(json).not.toContain(fixtureContext.reason);
    expect(json).not.toContain("signalReceiptIds");
    expect(json.length).toBeLessThan(20_000);
    const first = card.recent.find((intent) => intent.id === 0);
    expect(first?.market).toBe(huge);
    expect(first?.flags).toEqual(["market is not a Gemini symbol"]);
  });

  it("counts settled outcomes the executor signed, as totals only, and never a tampered one", () => {
    expect(buildScorecard(fixture).settled).toEqual({
      positions: 0,
      costCents: 0,
      payoutCents: 0,
      pnlCents: 0,
      paidOut: 0,
    });
    const document = (intentId: number, paid: boolean): Settlement => ({
      version: 1,
      chainId: 31337,
      policy: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      intentId,
      market: "GEMI-BTC2611202200-HI65000",
      eventTicker: "BTC2611202200",
      strikeCents: 6_500_000,
      expiresAt: "2026-11-20T22:00:00.000Z",
      outcome: "NO",
      costCents: 1_240,
      limitPrice: 31,
      contractsHundredths: 4_000,
      resolution: paid ? "no" : "yes",
      payoutCents: paid ? 4_000 : 0,
      pnlCents: paid ? 2_760 : -1_240,
      settlementValue: "64992.864",
      resolvedAt: "2026-11-20T22:00:08.232Z",
      venue: "simulated",
    });
    const verified = (doc: Settlement) =>
      ({
        status: "verified",
        hash: `0x${"11".repeat(32)}`,
        signer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        signature: `0x${"22".repeat(65)}`,
        storedAt: "2026-11-20T22:01:00.000Z",
        document: doc,
      }) as const;
    const card = buildScorecard({
      ...fixture,
      settlements: {
        0: verified(document(0, true)),
        1: verified(document(1, false)),
        2: { status: "tampered", hash: `0x${"33".repeat(32)}`, storedAt: "2026-11-20T22:01:00.000Z" },
      },
    });
    expect(card.settled).toEqual({
      positions: 2,
      costCents: 2_480,
      payoutCents: 4_000,
      pnlCents: 1_520,
      paidOut: 1,
    });
    // Totals only: no hash, signature or document of a settlement reaches the public page.
    expect(JSON.stringify(card)).not.toContain("11".repeat(32));
    expect(JSON.stringify(card)).not.toContain("64992.864");
  });
});

describe("publicAgentName", () => {
  it("clips the agent's own name and falls back to its address", () => {
    expect(publicAgentName("Grok Bot", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("Grok Bot");
    expect(publicAgentName(null, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("Agent 0x7099…79C8");
    expect(publicAgentName("x".repeat(500), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toHaveLength(48);
  });
});
