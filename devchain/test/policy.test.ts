/**
 * Behavior tests for both Policy contracts on a real anvil:
 * - `production`: `contracts/src/Policy.sol` compiled as is (v2, issue #23): the requested extensions,
 *   format checks, an approval that re-runs every rule, and roles that move with events.
 * - `reference`: `devchain/contracts/PolicyReference.sol`, the first production version plus the extensions.
 * Every rule test runs against both, and the places where v2 differs say so by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Abi } from "viem";
import {
  Category,
  hashContext,
  malformedReason,
  policyAbi,
  policyReferenceAbi,
  policyStateAt,
  reduceEvents,
  revertErrorName,
  SECONDS_PER_DAY,
  ZERO_HASH,
  type DecisionContext,
  type TradeIntentInput,
} from "@mandate/shared";
import { DEMO_POLICY, devAccount, loadPolicyArtifact, POLICY_CONTRACTS } from "../src";
import {
  deployTestPolicy,
  intentsFromEvents,
  proposeRaw,
  startTestAnvil,
  type TestAnvil,
  type TestPolicy,
} from "./harness";

const MARKET = "GEMI-BTC2611202200-HI65000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const crypto = (amountDollars: number, extra: Partial<TradeIntentInput> = {}): TradeIntentInput => ({
  market: MARKET,
  category: Category.Crypto,
  outcome: "YES",
  isBuy: true,
  amountCents: Math.round(amountDollars * 100),
  limitPrice: 65,
  ...extra,
});

const CONTEXT: DecisionContext = {
  version: 1,
  requestText: "Hedge my BTC.",
  planId: "plan_1",
  rungIndex: 0,
  ladderSummary: { eventTicker: "BTC2611202200", observedAt: "2026-11-16T12:00:00Z", rungs: [] },
  signalReceiptIds: [],
  reason: "Cheapest protection.",
  createdAt: "2026-11-16T12:00:01Z",
};

async function expectRevert(promise: Promise<unknown>, errorName: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected a ${errorName} revert`).not.toBeNull();
  expect(revertErrorName(error)).toBe(errorName);
}

describe("ABI parity", () => {
  const normalize = (abi: Abi) =>
    abi
      .filter((item) => item.type !== "constructor")
      .map((item) =>
        JSON.stringify(item, (key, value: unknown) => (key === "internalType" ? undefined : value)),
      )
      .sort();

  it("contracts/src/Policy.sol compiles to exactly policyAbi in @mandate/shared", () => {
    expect(normalize(loadPolicyArtifact("production").abi)).toEqual(normalize(policyAbi as unknown as Abi));
  });

  it("the reference contract compiles to the base ABI plus the extensions, nothing else", () => {
    expect(normalize(loadPolicyArtifact("reference").abi)).toEqual(
      normalize(policyReferenceAbi as unknown as Abi),
    );
  });
});

describe.each(POLICY_CONTRACTS)("Policy (%s) on a real anvil", (kind) => {
  const isReference = kind === "reference";
  let anvil: TestAnvil;
  let chain: TestPolicy;

  beforeAll(async () => {
    anvil = await startTestAnvil();
  });
  afterAll(async () => {
    await anvil.stop();
  });

  // Each test gets a fresh contract with the demo rules on the shared anvil.
  beforeEach(async () => {
    chain = await deployTestPolicy(anvil, kind);
    await chain.user.setPolicy(DEMO_POLICY);
  });

  it("exposes roles and the seeded rules", async () => {
    expect(await chain.user.getRoles()).toEqual({
      user: devAccount("user").address,
      agent: devAccount("agent").address,
      executor: devAccount("executor").address,
    });
    expect(await chain.outsider.getRules()).toEqual(DEMO_POLICY);
  });

  it("detects both extensions, which the production contract has since v2", async () => {
    expect(await chain.outsider.getCapabilities()).toEqual({ previewTrade: true, proposeWithContext: true });
  });

  it("approves a small allowed buy and stores it, with ids starting at 0", async () => {
    const contextHash = hashContext(CONTEXT);
    const result = await chain.agent.proposeTrade(crypto(10, { contextHash }));
    expect(result).toMatchObject({ intentId: 0, verdict: "approved", contextHashRecorded: true });

    expect(await chain.agent.getIntent(0)).toEqual({
      id: 0,
      market: MARKET,
      category: Category.Crypto,
      outcome: "YES",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 65,
      status: "approved",
      proposedAt: await anvil.latestTimestamp(),
      filledCents: 0,
      pnlCents: 0,
    });
    expect((await chain.user.getSnapshot()).committedCents).toBe(1_000);
    expect(await chain.user.getIntent(1)).toBeNull();
    expect(await chain.user.getIntent(-1)).toBeNull();

    const proposed = (await chain.outsider.getEvents({ fromBlock: chain.deployBlock })).filter(
      (e) => e.type === "IntentProposed",
    );
    expect(proposed).toEqual([
      expect.objectContaining({ intentId: 0, agent: devAccount("agent").address, contextHash }),
    ]);
  });

  it("rejects a zero amount as a verdict, not a revert", async () => {
    expect(await chain.agent.proposeTrade(crypto(0))).toMatchObject({
      intentId: 0,
      verdict: "rejected",
      reason: "zero amount",
    });
  });

  it("budget: rejects a buy over the remaining budget but allows a sell", async () => {
    await chain.user.setPolicy({ ...DEMO_POLICY, budgetCents: 3_000, approvalAboveCents: 0 });
    expect((await chain.agent.proposeTrade(crypto(25))).verdict).toBe("approved");
    expect(await chain.agent.proposeTrade(crypto(5.01))).toMatchObject({
      verdict: "rejected",
      reason: "over budget",
    });
    expect((await chain.agent.proposeTrade(crypto(5))).verdict).toBe("approved");
    expect((await chain.agent.proposeTrade(crypto(10, { isBuy: false }))).verdict).toBe("approved");
    expect((await chain.user.getSnapshot()).committedCents).toBe(3_000);
  });

  it("max trade: rejects a trade over the max size and keeps it in storage", async () => {
    expect(await chain.agent.proposeTrade(crypto(25.01))).toMatchObject({
      verdict: "rejected",
      reason: "over max trade size",
    });
    expect(await chain.agent.getIntent(0)).toMatchObject({ status: "rejected", amountCents: 2_501 });
  });

  it("category: rejects a category outside the allowed set", async () => {
    expect(await chain.agent.proposeTrade(crypto(5, { category: Category.Sports }))).toMatchObject({
      verdict: "rejected",
      reason: "category not allowed",
    });
  });

  it("approval threshold: holds a trade above it, then the user approves it", async () => {
    const held = await chain.agent.proposeTrade(crypto(22));
    expect(held).toMatchObject({ verdict: "needs_approval" });
    expect((await chain.user.getSnapshot()).committedCents).toBe(0); // waiting reserves nothing

    expect(await chain.user.approveIntent(held.intentId)).toMatchObject({ verdict: "approved" });
    expect((await chain.user.getIntent(held.intentId))?.status).toBe("approved");
    expect((await chain.user.getSnapshot()).committedCents).toBe(2_200);
    await expectRevert(chain.user.approveIntent(held.intentId), "WrongStatus");
  });

  it("approval threshold: holds a trade above it, then the user rejects it", async () => {
    const held = await chain.agent.proposeTrade(crypto(22));
    await chain.user.rejectIntent(held.intentId);
    expect((await chain.user.getIntent(held.intentId))?.status).toBe("rejected");
    const events = await chain.outsider.getEvents({ fromBlock: chain.deployBlock });
    expect(events.at(-1)).toMatchObject({ type: "IntentRejected", reason: "rejected by user" });
    await expectRevert(chain.user.rejectIntent(held.intentId), "WrongStatus");
  });

  it(`approval re-checks ${isReference ? "only the budget" : "every rule (v2)"}`, async () => {
    await chain.user.setPolicy({ ...DEMO_POLICY, budgetCents: 4_000 });
    const held = await chain.agent.proposeTrade(crypto(22));
    expect(held.verdict).toBe("needs_approval");
    expect((await chain.agent.proposeTrade(crypto(20))).verdict).toBe("approved"); // commits 2000 of 4000
    expect(await chain.user.approveIntent(held.intentId)).toMatchObject({
      verdict: "rejected",
      reason: "over budget",
    });

    // A held sell approved while paused: the reference contract approves it; v2 refuses it with the
    // rule's reason and marks it rejected, as the event says.
    const second = await chain.agent.proposeTrade(crypto(21, { isBuy: false }));
    await chain.user.setPaused(true);
    expect(await chain.user.approveIntent(second.intentId)).toMatchObject(
      isReference ? { verdict: "approved" } : { verdict: "rejected", reason: "agent paused" },
    );
    expect((await chain.user.getIntent(second.intentId))?.status).toBe(isReference ? "approved" : "rejected");
    if (isReference) return;

    // A rule tightened while it waited: the category is no longer allowed.
    await chain.user.setPolicy({ ...DEMO_POLICY, budgetCents: 10_000 });
    const third = await chain.agent.proposeTrade(crypto(22));
    await chain.user.setPolicy({ ...DEMO_POLICY, budgetCents: 10_000, allowedCategories: 0 });
    expect(await chain.user.approveIntent(third.intentId)).toMatchObject({
      verdict: "rejected",
      reason: "category not allowed",
    });
  });

  it.runIf(!isReference)("records a malformed proposal and rejects it before any rule (v2)", async () => {
    // Paused, so the format checks are seen to run first. The raw call is what a key outside the MCP
    // server can send; our own client refuses these before sending.
    await chain.user.setPaused(true);
    const raw = {
      market: MARKET,
      category: 0,
      outcome: "YES",
      isBuy: true,
      amountCents: 100n,
      limitPrice: 50n,
    };
    const cases: [Partial<typeof raw>, string][] = [
      [{ market: "" }, "invalid market"],
      [{ market: "x".repeat(129) }, "invalid market"],
      [{ market: "é".repeat(65) }, "invalid market"], // 130 bytes in 65 characters
      [{ outcome: "yes" }, "invalid outcome"],
      [{ limitPrice: 0n }, "invalid limit price"],
      [{ limitPrice: 100n }, "invalid limit price"],
      [{ limitPrice: 2n ** 256n - 1n }, "invalid limit price"],
      [{ market: "x".repeat(128) }, "agent paused"], // exactly 128 bytes is well formed
    ];
    for (const [patch, reason] of cases) {
      const intentId = await proposeRaw(chain.agent, { ...raw, ...patch });
      const toBlock = await chain.outsider.publicClient.getBlockNumber({ cacheTime: 0 });
      const events = await chain.outsider.getEvents({ fromBlock: chain.deployBlock, toBlock });
      const own = events.filter((e) => "intentId" in e && e.intentId === intentId).map((e) => e.type);
      expect(own, reason).toEqual(["IntentProposed", "IntentRejected"]);
      expect(events.at(-1)).toMatchObject({ type: "IntentRejected", intentId, reason });
      expect(
        malformedReason({ market: raw.market, outcome: raw.outcome, limitPrice: raw.limitPrice, ...patch }),
      ).toBe(reason === "agent paused" ? null : reason);
    }
  });

  it.runIf(!isReference)("moves roles with events, and refuses the zero address (v2)", async () => {
    const outsider = devAccount("outsider").address;
    await expectRevert(chain.user.setAgent(ZERO_ADDRESS), "ZeroAddress");
    await expectRevert(chain.user.setExecutor(ZERO_ADDRESS), "ZeroAddress");
    await expectRevert(chain.user.setUser(ZERO_ADDRESS), "ZeroAddress");
    await expectRevert(chain.agent.setUser(outsider), "NotUser");

    await chain.user.setAgent(outsider);
    await chain.user.setExecutor(outsider);
    await chain.user.setUser(outsider);
    expect(await chain.outsider.getRoles()).toEqual({ user: outsider, agent: outsider, executor: outsider });
    // The old owner is no longer the user.
    await expectRevert(chain.user.setPaused(true), "NotUser");

    const toBlock = await chain.outsider.publicClient.getBlockNumber({ cacheTime: 0 });
    const roles = (await chain.outsider.getEvents({ fromBlock: chain.deployBlock, toBlock }))
      .filter((e) => e.type === "UserChanged" || e.type === "AgentChanged" || e.type === "ExecutorChanged")
      .map((e) => [e.type, e.previous, e.current]);
    expect(roles).toEqual([
      ["UserChanged", ZERO_ADDRESS, devAccount("user").address],
      ["AgentChanged", ZERO_ADDRESS, devAccount("agent").address],
      ["ExecutorChanged", ZERO_ADDRESS, devAccount("executor").address],
      ["AgentChanged", devAccount("agent").address, outsider],
      ["ExecutorChanged", devAccount("executor").address, outsider],
      ["UserChanged", devAccount("user").address, outsider],
    ]);
  });

  it("daily loss: stops new intents once today's realized loss reaches the limit, until the next UTC day", async () => {
    for (const id of [0, 1]) {
      expect((await chain.agent.proposeTrade(crypto(20))).verdict).toBe("approved");
      await chain.executor.recordResult({ intentId: id, filled: true, filledCents: 2_000, pnlCents: -2_000 });
    }
    expect((await chain.user.getSnapshot()).lossTodayCents).toBe(4_000);
    // The daily loss check runs before max trade size and category.
    expect(await chain.agent.proposeTrade(crypto(30, { category: Category.Sports }))).toMatchObject({
      verdict: "rejected",
      reason: "daily loss limit reached",
    });

    await anvil.advanceTime(SECONDS_PER_DAY);
    expect((await chain.user.getSnapshot()).lossTodayCents).toBe(0);
    expect((await chain.agent.proposeTrade(crypto(1))).verdict).toBe("approved");
  });

  it("pause: rejects everything and resume restores trading", async () => {
    await chain.user.setPaused(true);
    expect(await chain.agent.proposeTrade(crypto(1))).toMatchObject({
      verdict: "rejected",
      reason: "agent paused",
    });
    expect(await chain.agent.proposeTrade(crypto(0, { isBuy: false }))).toMatchObject({
      reason: "agent paused",
    });
    expect((await chain.user.getRules()).paused).toBe(true);
    await chain.user.setPaused(false);
    expect((await chain.agent.proposeTrade(crypto(1))).verdict).toBe("approved");
  });

  it("releases unfilled budget when results are recorded", async () => {
    await chain.agent.proposeTrade(crypto(20));
    await chain.agent.proposeTrade(crypto(10));
    expect((await chain.user.getSnapshot()).committedCents).toBe(3_000);

    await chain.executor.recordResult({ intentId: 0, filled: false, filledCents: 0, pnlCents: 0 });
    expect((await chain.user.getSnapshot()).committedCents).toBe(1_000);
    await chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 600, pnlCents: 150 });
    expect((await chain.user.getSnapshot()).committedCents).toBe(600);

    expect(await chain.user.getIntent(0)).toMatchObject({ status: "failed", filledCents: 0, pnlCents: 0 });
    expect(await chain.user.getIntent(1)).toMatchObject({
      status: "executed",
      filledCents: 600,
      pnlCents: 150,
    });
    await expectRevert(
      chain.executor.recordResult({ intentId: 1, filled: true, filledCents: 600, pnlCents: 0 }),
      "WrongStatus",
    );
  });

  it("refuses fills larger than the intent, and records an unfilled result as zero fill", async () => {
    await chain.agent.proposeTrade(crypto(10));
    await expectRevert(
      chain.executor.recordResult({ intentId: 0, filled: true, filledCents: 1_001, pnlCents: 0 }),
      "FillExceedsIntent",
    );
    // filled=false with a non-zero fill is accepted and stored as a zero fill.
    await chain.executor.recordResult({ intentId: 0, filled: false, filledCents: 500, pnlCents: 0 });
    expect(await chain.user.getIntent(0)).toMatchObject({ status: "failed", filledCents: 0 });
    const events = await chain.outsider.getEvents({ fromBlock: chain.deployBlock });
    expect(events.at(-1)).toMatchObject({ type: "ResultRecorded", filled: false, filledCents: 0 });

    // Schema validation stops malformed intents before they cost gas.
    await expect(chain.agent.proposeTrade(crypto(10, { limitPrice: 100 }))).rejects.toThrow();
  });

  it("access control: only the user, agent and executor can act in their roles", async () => {
    await expectRevert(chain.agent.setPolicy(DEMO_POLICY), "NotUser");
    await expectRevert(chain.agent.setPaused(true), "NotUser");
    await expectRevert(chain.executor.setPaused(true), "NotUser");
    await expectRevert(chain.agent.setAgent(devAccount("outsider").address), "NotUser");
    await expectRevert(chain.agent.setExecutor(devAccount("outsider").address), "NotUser");

    await expectRevert(chain.user.proposeTrade(crypto(1)), "NotAgent");
    await expectRevert(chain.outsider.proposeTrade(crypto(1)), "NotAgent");
    await expectRevert(chain.executor.proposeTrade(crypto(1)), "NotAgent");

    const held = await chain.agent.proposeTrade(crypto(22));
    await expectRevert(chain.agent.approveIntent(held.intentId), "NotUser");
    await expectRevert(chain.agent.rejectIntent(held.intentId), "NotUser");

    const approved = await chain.agent.proposeTrade(crypto(1));
    const result = { intentId: approved.intentId, filled: true, filledCents: 100, pnlCents: 0 };
    await expectRevert(chain.agent.recordResult(result), "NotExecutor");
    await expectRevert(chain.user.recordResult(result), "NotExecutor");
    await expectRevert(chain.outsider.recordResult(result), "NotExecutor");

    // Role rotation by the user.
    await chain.user.setAgent(devAccount("outsider").address);
    expect((await chain.outsider.proposeTrade(crypto(1))).verdict).toBe("approved");
    await expectRevert(chain.agent.proposeTrade(crypto(1)), "NotAgent");
    await chain.user.setExecutor(devAccount("outsider").address);
    await chain.outsider.recordResult(result);
    expect((await chain.user.getRoles()).executor).toBe(devAccount("outsider").address);
  });

  it("approving an id that does not exist reverts", async () => {
    await expect(chain.user.approveIntent(5)).rejects.toThrow(/approveIntent reverted/);
  });

  it("previewTrade answers from the contract without changing state", async () => {
    const source = "contract";
    const before = await chain.user.getSnapshot();
    expect(
      await chain.outsider.previewTrade({ category: Category.Crypto, isBuy: true, amountCents: 2_200 }),
    ).toEqual({ verdict: "needs_approval", source });
    expect(await chain.outsider.previewTrade({ category: 200, isBuy: true, amountCents: 1 })).toEqual({
      verdict: "rejected",
      reason: "category not allowed",
      source,
    });
    expect((await chain.user.getSnapshot()).committedCents).toBe(before.committedCents);
    expect(await chain.user.getIntentCount()).toBe(0);
  });

  it("the event reducer, completed with getIntent where needed, rebuilds the state the contract holds", async () => {
    await chain.agent.proposeTrade(crypto(10));
    await chain.agent.proposeTrade(crypto(22));
    await chain.agent.proposeTrade(crypto(30));
    await chain.user.approveIntent(1);
    await chain.executor.recordResult({ intentId: 0, filled: true, filledCents: 800, pnlCents: -300 });
    await chain.user.setPaused(true);
    await chain.agent.proposeTrade(crypto(1, { contextHash: ZERO_HASH }));

    const events = await chain.outsider.getEvents({ fromBlock: chain.deployBlock });
    const state = reduceEvents(events);
    const snapshot = await chain.user.getSnapshot();
    expect(state.rules).toEqual(snapshot.rules);
    expect(policyStateAt(state, snapshot.blockTimestamp)).toEqual({
      committedCents: snapshot.committedCents,
      lossTodayCents: snapshot.lossTodayCents,
    });
    expect(await intentsFromEvents(state, chain.outsider)).toEqual(await chain.user.getIntents());
    expect(state.rejectionsByReason).toEqual({ "over max trade size": 1, "agent paused": 1 });
  });
});
