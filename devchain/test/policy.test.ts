import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Abi } from "viem";
import {
  Category,
  hashContext,
  listIntents,
  policyAbi,
  policyStateAt,
  reduceEvents,
  revertErrorName,
  SECONDS_PER_DAY,
  ZERO_HASH,
  type DecisionContext,
  type TradeIntentInput,
} from "@mandate/shared";
import { DEMO_POLICY, devAccount, loadPolicyArtifact } from "../src";
import { deployTestPolicy, startTestAnvil, type TestAnvil, type TestPolicy } from "./harness";

const crypto = (amountDollars: number, extra: Partial<TradeIntentInput> = {}): TradeIntentInput => ({
  market: "GEMI-BTC2611202200-HI65000",
  category: Category.Crypto,
  outcome: "YES",
  isBuy: true,
  amountCents: Math.round(amountDollars * 100),
  limitPrice: 65,
  ...extra,
});

async function expectRevert(promise: Promise<unknown>, errorName: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected a ${errorName} revert`).not.toBeNull();
  expect(revertErrorName(error)).toBe(errorName);
}

describe("reference contract ABI", () => {
  it("compiles to exactly the ABI in @mandate/shared", () => {
    const normalize = (abi: Abi) =>
      abi
        .filter((item) => item.type !== "constructor")
        .map((item) =>
          JSON.stringify(item, (key, value: unknown) => (key === "internalType" ? undefined : value)),
        )
        .sort();
    expect(normalize(loadPolicyArtifact().abi)).toEqual(normalize(policyAbi as unknown as Abi));
  });
});

describe("PolicyReference on a real anvil", () => {
  let anvil: TestAnvil;
  let chain: TestPolicy;

  beforeAll(async () => {
    anvil = await startTestAnvil();
  });
  afterAll(async () => {
    await anvil.stop();
  });

  // Each test gets a fresh contract with the demo policy on the shared anvil.
  beforeEach(async () => {
    chain = await deployTestPolicy(anvil);
    await chain.owner.setPolicy(DEMO_POLICY);
  });

  it("exposes roles and the seeded policy", async () => {
    expect(await chain.owner.getRoles()).toEqual({
      owner: devAccount("owner").address,
      agent: devAccount("agent").address,
      executor: devAccount("executor").address,
    });
    expect(await chain.outsider.getPolicy()).toEqual(DEMO_POLICY);
  });

  it("approves a small allowed buy and stores it with its context hash", async () => {
    const context: DecisionContext = {
      version: 1,
      requestText: "Hedge my BTC.",
      planId: "plan_1",
      rungIndex: 0,
      ladderSummary: { eventTicker: "BTC2611202200", observedAt: "2026-11-16T12:00:00Z", rungs: [] },
      signalReceiptIds: [],
      reason: "Cheapest protection.",
      createdAt: "2026-11-16T12:00:01Z",
    };
    const contextHash = hashContext(context);
    const result = await chain.agent.proposeTrade(crypto(10, { contextHash }));
    expect(result).toMatchObject({ intentId: 1, verdict: "approved" });

    const intent = await chain.agent.getIntent(1);
    expect(intent).toMatchObject({
      id: 1,
      agent: devAccount("agent").address,
      market: "GEMI-BTC2611202200-HI65000",
      category: Category.Crypto,
      outcome: "YES",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 65,
      contextHash,
      status: "approved",
      reason: null,
      filledCents: null,
    });
    expect((await chain.owner.getSnapshot()).spentCents).toBe(1_000);
    expect(await chain.owner.getIntent(99)).toBeNull();
  });

  it("rule 1: rejects a buy over the remaining budget but allows a sell", async () => {
    await chain.owner.setPolicy({ ...DEMO_POLICY, budgetCents: 3_000, approvalAboveCents: 0 });
    expect((await chain.agent.proposeTrade(crypto(25))).verdict).toBe("approved");
    expect(await chain.agent.proposeTrade(crypto(5.01))).toMatchObject({
      verdict: "rejected",
      reason: "OVER_BUDGET",
    });
    expect((await chain.agent.proposeTrade(crypto(5))).verdict).toBe("approved");
    expect((await chain.agent.proposeTrade(crypto(10, { isBuy: false }))).verdict).toBe("approved");
    expect((await chain.owner.getSnapshot()).spentCents).toBe(3_000);
  });

  it("rule 2: rejects a trade over the max size", async () => {
    expect(await chain.agent.proposeTrade(crypto(25.01))).toMatchObject({
      verdict: "rejected",
      reason: "OVER_MAX_TRADE",
    });
    const intent = await chain.agent.getIntent(1);
    expect(intent).toMatchObject({ status: "rejected", reason: "OVER_MAX_TRADE", amountCents: 2_501 });
  });

  it("rule 3: rejects a category outside the allowed set", async () => {
    expect(await chain.agent.proposeTrade(crypto(5, { category: Category.Sports }))).toMatchObject({
      verdict: "rejected",
      reason: "CATEGORY_NOT_ALLOWED",
    });
  });

  it("rule 4: holds a trade above the threshold, then the owner approves it", async () => {
    const held = await chain.agent.proposeTrade(crypto(22));
    expect(held).toMatchObject({ verdict: "needs_approval" });
    expect((await chain.owner.getSnapshot()).spentCents).toBe(0); // waiting reserves nothing

    expect(await chain.owner.approveIntent(held.intentId)).toMatchObject({ verdict: "approved" });
    expect((await chain.owner.getIntent(held.intentId))?.status).toBe("approved");
    expect((await chain.owner.getSnapshot()).spentCents).toBe(2_200);
    await expectRevert(chain.owner.approveIntent(held.intentId), "IntentNotPending");
  });

  it("rule 4: holds a trade above the threshold, then the owner rejects it", async () => {
    const held = await chain.agent.proposeTrade(crypto(22));
    await chain.owner.rejectIntent(held.intentId);
    expect(await chain.owner.getIntent(held.intentId)).toMatchObject({
      status: "rejected",
      reason: "REJECTED_BY_OWNER",
    });
    await expectRevert(chain.owner.rejectIntent(held.intentId), "IntentNotPending");
  });

  it("rule 4: re-checks the budget at approval time", async () => {
    await chain.owner.setPolicy({ ...DEMO_POLICY, budgetCents: 4_000 });
    const held = await chain.agent.proposeTrade(crypto(22));
    expect(held.verdict).toBe("needs_approval");
    expect((await chain.agent.proposeTrade(crypto(20))).verdict).toBe("approved"); // spends 2000 of 4000
    expect(await chain.owner.approveIntent(held.intentId)).toMatchObject({
      verdict: "rejected",
      reason: "OVER_BUDGET",
    });
  });

  it("rule 5: stops new intents once today's realized loss reaches the limit, until the next UTC day", async () => {
    for (const id of [1, 2]) {
      expect((await chain.agent.proposeTrade(crypto(20))).verdict).toBe("approved");
      await chain.executor.recordResult({ intentId: id, filled: true, filledCents: 2_000, pnlCents: -2_000 });
    }
    expect((await chain.owner.getSnapshot()).lossTodayCents).toBe(4_000);
    expect(await chain.agent.proposeTrade(crypto(1))).toMatchObject({
      verdict: "rejected",
      reason: "DAILY_LOSS_LIMIT",
    });

    await anvil.advanceTime(SECONDS_PER_DAY);
    expect((await chain.owner.getSnapshot()).lossTodayCents).toBe(0);
    expect((await chain.agent.proposeTrade(crypto(1))).verdict).toBe("approved");
  });

  it("rule 6: pause rejects everything and resume restores trading", async () => {
    await chain.owner.setPaused(true);
    expect(await chain.agent.proposeTrade(crypto(1))).toMatchObject({
      verdict: "rejected",
      reason: "PAUSED",
    });
    expect(await chain.agent.proposeTrade(crypto(1, { isBuy: false }))).toMatchObject({ reason: "PAUSED" });
    expect((await chain.owner.getPolicy()).paused).toBe(true);
    await chain.owner.setPaused(false);
    expect((await chain.agent.proposeTrade(crypto(1))).verdict).toBe("approved");
  });

  it("releases unfilled budget when results are recorded", async () => {
    await chain.agent.proposeTrade(crypto(20));
    await chain.agent.proposeTrade(crypto(10));
    expect((await chain.owner.getSnapshot()).spentCents).toBe(3_000);

    await chain.executor.recordResult({ intentId: 1, filled: false, filledCents: 0, pnlCents: 0 });
    expect((await chain.owner.getSnapshot()).spentCents).toBe(1_000);
    await chain.executor.recordResult({ intentId: 2, filled: true, filledCents: 600, pnlCents: 150 });
    expect((await chain.owner.getSnapshot()).spentCents).toBe(600);

    expect(await chain.owner.getIntent(1)).toMatchObject({ status: "unfilled", filledCents: 0, pnlCents: 0 });
    expect(await chain.owner.getIntent(2)).toMatchObject({
      status: "filled",
      filledCents: 600,
      pnlCents: 150,
    });
    await expectRevert(
      chain.executor.recordResult({ intentId: 2, filled: true, filledCents: 600, pnlCents: 0 }),
      "IntentNotApproved",
    );
  });

  it("refuses invalid results and malformed proposals", async () => {
    await chain.agent.proposeTrade(crypto(10));
    await expectRevert(
      chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 1_001, pnlCents: 0 }),
      "InvalidFill",
    );
    await expectRevert(
      chain.executor.recordResult({ intentId: 1, filled: false, filledCents: 1, pnlCents: 0 }),
      "InvalidFill",
    );
    // Schema validation stops malformed intents before they cost gas.
    await expect(chain.agent.proposeTrade(crypto(10, { limitPrice: 100 }))).rejects.toThrow();
    await expect(chain.agent.proposeTrade(crypto(0))).rejects.toThrow();
  });

  it("access control: only the owner, agent and executor can act in their roles", async () => {
    await expectRevert(chain.agent.setPolicy(DEMO_POLICY), "NotOwner");
    await expectRevert(chain.agent.setPaused(true), "NotOwner");
    await expectRevert(chain.executor.setPaused(true), "NotOwner");
    await expectRevert(chain.agent.setAgent(devAccount("outsider").address), "NotOwner");

    await expectRevert(chain.owner.proposeTrade(crypto(1)), "NotAgent");
    await expectRevert(chain.outsider.proposeTrade(crypto(1)), "NotAgent");
    await expectRevert(chain.executor.proposeTrade(crypto(1)), "NotAgent");

    const held = await chain.agent.proposeTrade(crypto(22));
    await expectRevert(chain.agent.approveIntent(held.intentId), "NotOwner");
    await expectRevert(chain.agent.rejectIntent(held.intentId), "NotOwner");

    const approved = await chain.agent.proposeTrade(crypto(1));
    const result = { intentId: approved.intentId, filled: true, filledCents: 100, pnlCents: 0 };
    await expectRevert(chain.agent.recordResult(result), "NotExecutor");
    await expectRevert(chain.owner.recordResult(result), "NotExecutor");
    await expectRevert(chain.outsider.recordResult(result), "NotExecutor");

    // Role rotation by the owner.
    await chain.owner.setAgent(devAccount("outsider").address);
    expect((await chain.outsider.proposeTrade(crypto(1))).verdict).toBe("approved");
    await expectRevert(chain.agent.proposeTrade(crypto(1)), "NotAgent");
  });

  it("previewTrade matches proposeTrade without changing state", async () => {
    const before = await chain.owner.getSnapshot();
    expect(
      await chain.outsider.previewTrade({ category: Category.Crypto, isBuy: true, amountCents: 2_200 }),
    ).toEqual({
      verdict: "needs_approval",
    });
    expect(await chain.outsider.previewTrade({ category: 200, isBuy: true, amountCents: 1 })).toEqual({
      verdict: "rejected",
      reason: "CATEGORY_NOT_ALLOWED",
    });
    const after = await chain.owner.getSnapshot();
    expect(after.spentCents).toBe(before.spentCents);
    expect(await chain.owner.getIntentCount()).toBe(0);
  });

  it("the event reducer rebuilds the same state the contract holds", async () => {
    await chain.agent.proposeTrade(crypto(10));
    await chain.agent.proposeTrade(crypto(22));
    await chain.agent.proposeTrade(crypto(30));
    await chain.owner.approveIntent(2);
    await chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 800, pnlCents: -300 });
    await chain.owner.setPaused(true);
    await chain.agent.proposeTrade(crypto(1, { contextHash: ZERO_HASH }));

    const events = await chain.outsider.getEvents({ fromBlock: chain.deployBlock });
    const state = reduceEvents(events);
    const snapshot = await chain.owner.getSnapshot();
    expect(state.policy).toEqual(snapshot.policy);
    expect(policyStateAt(state, snapshot.blockTimestamp)).toEqual({
      spentCents: snapshot.spentCents,
      lossTodayCents: snapshot.lossTodayCents,
    });
    const chainIntents = await chain.owner.getIntents();
    expect(
      listIntents(state).map(({ proposedTxHash: _p, decidedTxHash: _d, resultTxHash: _r, ...i }) => i),
    ).toEqual(chainIntents);
    expect(state.rejectionsByReason).toEqual({ OVER_MAX_TRADE: 1, PAUSED: 1 });
  });
});
