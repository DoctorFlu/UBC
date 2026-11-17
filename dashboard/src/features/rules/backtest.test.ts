import { DEMO_POLICY } from "@mandate/devchain";
import {
  Category,
  type Intent,
  type PolicyClient,
  type PolicyRules,
  categoryMask,
  intentsMissingDetails,
  reduceEvents,
} from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureRules, fixtureSnapshot } from "@/fixtures";
import { buildChainView } from "@/lib/live/chain-view";
import type { ChainView } from "@/lib/live/types";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { type Verdict, backtest } from "./backtest";

const fixtureChain = fixtureSnapshot.chain;
if (!fixtureChain) throw new Error("the fixture snapshot has a chain");

describe("backtest on the fixture history", () => {
  it("changes nothing when the draft is the mandate every intent met", () => {
    const result = backtest(fixtureChain, fixtureRules);
    expect(result.changed).toEqual([]);
    expect(result.unknown).toBe(0);
    expect(result.draft).toEqual(result.actual);
    expect(result.actual).toEqual({ approved: 3, held: 2, rejected: 2 });
  });

  it("rejects what a lower max trade size no longer allows", () => {
    const result = backtest(fixtureChain, { ...fixtureRules, maxTradeCents: 1_300, approvalAboveCents: 0 });
    expect(result.changed.map((intent) => [intent.id, intent.draft])).toEqual([
      [1, { kind: "rejected", reason: "over max trade size" }],
      [3, { kind: "rejected", reason: "over max trade size" }],
      // The max trade size is checked before the category, as the contract does.
      [5, { kind: "rejected", reason: "over max trade size" }],
      [6, { kind: "rejected", reason: "over max trade size" }],
    ]);
  });

  it("approves held intents once the threshold is above them, and stops asking at 0", () => {
    const result = backtest(fixtureChain, { ...fixtureRules, approvalAboveCents: 0 });
    expect(result.changed.map((intent) => [intent.id, intent.actual.kind, intent.draft?.kind])).toEqual([
      [3, "held", "approved"],
      [6, "held", "approved"],
    ]);
    expect(result.draft).toEqual({ approved: 5, held: 0, rejected: 2 });
  });
});

// ------------------------------------------------------------------ against the contract

const BTC = BTC_ABOVE_65K;
const SPORTS = "GEMI-NBA2611200100-HILAL";

function buy(market: string, amountCents: number, category: number = Category.Crypto) {
  return { market, category, outcome: "NO" as const, isBuy: true, amountCents, limitPrice: 30 };
}

async function chainView(client: PolicyClient): Promise<ChainView> {
  const events = await client.getEvents({ fromBlock: 0n });
  const state = reduceEvents(events);
  const details = new Map<number, Intent>();
  for (const id of intentsMissingDetails(state)) {
    const intent = await client.getIntent(id);
    if (intent) details.set(id, intent);
  }
  const block = await client.publicClient.getBlock({ blockTag: "latest" });
  return buildChainView(
    state,
    { blockNumber: Number(block.number), timestamp: Number(block.timestamp) },
    details,
  );
}

function verdictOf(chain: ChainView, id: number): Verdict {
  const first = chain.events.find(
    (event) => "intentId" in event && event.intentId === id && event.type !== "IntentProposed",
  );
  if (first?.type === "IntentApproved") return { kind: "approved" };
  if (first?.type === "IntentNeedsApproval") return { kind: "held" };
  if (first?.type === "IntentRejected") return { kind: "rejected", reason: first.reason };
  throw new Error(`intent ${String(id)} has no verdict`);
}

/**
 * The replay against the real thing: a history on one chain under the demo mandate, the same history
 * played on a second chain under the draft (the same proposals; the owner's approvals and rejections
 * where the draft also held the intent; the executor's results where the draft let the intent trade),
 * and the backtest of the first history must give exactly the second chain's verdicts.
 */
describe("backtest against the Policy contract", () => {
  let actual: TestChain;
  let mirror: TestChain;
  const draft: PolicyRules = {
    budgetCents: 9_000,
    maxTradeCents: 3_000,
    allowedCategories: categoryMask([Category.Crypto, Category.Sports]),
    approvalAboveCents: 2_500,
    dailyLossCents: 2_000,
    paused: false,
  };

  beforeAll(async () => {
    [actual, mirror] = await Promise.all([
      startTestChain({ policy: DEMO_POLICY }),
      startTestChain({ policy: draft }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([actual.stop(), mirror.stop()]);
  });

  it("gives the verdicts the contract gives under the draft", async () => {
    type Step =
      | { kind: "propose"; input: ReturnType<typeof buy> }
      | { kind: "approve"; id: number }
      | { kind: "reject"; id: number }
      | { kind: "result"; id: number; filledCents: number; pnlCents: number };
    const history: Step[] = [
      { kind: "propose", input: buy(BTC, 1_240) }, // 0: approved
      { kind: "result", id: 0, filledCents: 1_240, pnlCents: -1_500 },
      { kind: "propose", input: buy(BTC, 2_160) }, // 1: held, then approved by the owner
      { kind: "approve", id: 1 },
      { kind: "result", id: 1, filledCents: 2_160, pnlCents: 0 },
      { kind: "propose", input: buy(BTC, 2_300) }, // 2: held, then rejected by the owner
      { kind: "reject", id: 2 },
      { kind: "propose", input: buy(BTC, 2_800) }, // 3: over max trade size
      { kind: "propose", input: buy(SPORTS, 1_000, Category.Sports) }, // 4: category not allowed
      { kind: "propose", input: buy(BTC, 900) }, // 5: approved, never filled
      { kind: "propose", input: buy(BTC, 400) }, // 6: approved, filled at a loss
      { kind: "result", id: 6, filledCents: 400, pnlCents: -700 },
      { kind: "propose", input: buy(BTC, 300) }, // 7: after the losses
    ];

    for (const step of history) {
      switch (step.kind) {
        case "propose":
          await actual.agent.proposeTrade(step.input);
          await mirror.agent.proposeTrade(step.input);
          break;
        case "approve":
        case "reject": {
          await (step.kind === "approve"
            ? actual.user.approveIntent(step.id)
            : actual.user.rejectIntent(step.id));
          // The owner decides under the draft only if the draft held the intent too.
          const held = (await mirror.user.getIntent(step.id))?.status === "needs_approval";
          if (held) {
            await (step.kind === "approve"
              ? mirror.user.approveIntent(step.id)
              : mirror.user.rejectIntent(step.id));
          }
          break;
        }
        case "result": {
          const result = {
            intentId: step.id,
            filled: true,
            filledCents: step.filledCents,
            pnlCents: step.pnlCents,
          };
          await actual.executor.recordResult(result);
          if ((await mirror.user.getIntent(step.id))?.status === "approved") {
            await mirror.executor.recordResult(result);
          }
          break;
        }
      }
    }

    const history1 = await chainView(actual.user);
    const underDraft = await chainView(mirror.user);
    const result = backtest(history1, draft);
    expect(result.unknown).toBe(0);
    expect(result.intents).toHaveLength(8);
    for (const intent of result.intents) {
      expect({ id: intent.id, verdict: intent.draft }).toEqual({
        id: intent.id,
        verdict: verdictOf(underDraft, intent.id),
      });
      expect(intent.actual).toEqual(verdictOf(history1, intent.id));
    }
    // The history exercises every kind of change, so the comparison above means something.
    expect(result.changed.length).toBeGreaterThanOrEqual(4);
    expect(new Set(result.intents.map((intent) => intent.draft?.kind))).toEqual(
      new Set(["approved", "held", "rejected"]),
    );
  }, 120_000);
});
