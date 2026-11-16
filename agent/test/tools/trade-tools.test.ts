import { describe, expect, it } from "vitest";
import { InsufficientFundsError } from "viem";
import { Category, categoryMask, PolicyClientError, PolicyRevertError, verifyContext } from "@mandate/shared";
import { executePlan } from "../../src/tools/execute-plan";
import { getIntent } from "../../src/tools/get-intent";
import { planHedge } from "../../src/tools/plan-hedge";
import { proposeTrade } from "../../src/tools/propose-trade";
import { simulateTrade } from "../../src/tools/simulate-trade";
import { FakePolicy, harness, ladderSymbol, SPORTS_SYMBOL } from "../fakes";

type Row = Record<string, unknown>;
const MARKET = ladderSymbol(63_000);
const trade = { market: MARKET, outcome: "NO" as const, limitPrice: 30 };

describe("simulate_trade", () => {
  it("predicts approval without sending anything", async () => {
    const h = harness();
    const { structured, summary } = await simulateTrade.run({ ...trade, amountCents: 1_000 }, h.ctx);
    expect(structured).toMatchObject({
      status: "ok",
      simulation: {
        wouldBe: "approved",
        source: "offchain",
        rule: null,
        trade: { category: "Crypto", side: "buy" },
      },
      nextAction: { actor: "agent" },
    });
    expect(h.policy.proposed).toHaveLength(0);
    expect(summary).toContain("Nothing was sent");
  });

  it("names the rule and the numbers that would stop a trade", async () => {
    const { structured, summary } = await simulateTrade.run({ ...trade, amountCents: 3_000 }, harness().ctx);
    expect(structured).toMatchObject({
      simulation: {
        wouldBe: "rejected",
        rule: {
          rule: "maxTradeCents",
          code: "OVER_MAX_TRADE_SIZE",
          contractReason: "over max trade size",
          detail: "Max trade $25.00; this trade $30.00.",
        },
      },
      reasons: [{ code: "OVER_MAX_TRADE_SIZE" }],
      nextAction: { actor: "owner" },
    });
    expect(summary).toContain("would be rejected");
  });

  it("reads the category from Gemini, not from the agent", async () => {
    const { structured } = await simulateTrade.run(
      { market: SPORTS_SYMBOL, outcome: "YES", amountCents: 500, limitPrice: 55 },
      harness().ctx,
    );
    expect(structured).toMatchObject({
      simulation: {
        wouldBe: "rejected",
        rule: { rule: "allowedCategories", detail: "This market is in Sports; allowed: Crypto." },
      },
    });
  });

  it("says when the contract itself answered, and explains a hold", async () => {
    const h = harness();
    h.policy.caps = { previewTrade: true, proposeWithContext: true };
    const { structured, summary } = await simulateTrade.run({ ...trade, amountCents: 2_200 }, h.ctx);
    expect(structured).toMatchObject({
      simulation: {
        wouldBe: "needs_approval",
        source: "contract",
        rule: { code: "OWNER_APPROVAL_REQUIRED" },
      },
    });
    expect(summary).toContain("the contract's previewTrade");
  });

  it("answers unavailable for an unknown market", async () => {
    const { structured } = await simulateTrade.run(
      { ...trade, market: "GEMI-NOPE-1", amountCents: 100 },
      harness().ctx,
    );
    expect(structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "MARKET_NOT_FOUND" }],
      nextAction: { actor: "agent" },
    });
  });
});

describe("propose_trade", () => {
  const args = { ...trade, reason: "Owner asked to protect 0.05 BTC below $63k." };

  it("approves, holds and rejects with the contract's verdicts (the three demo cases)", async () => {
    const h = harness();
    const ok = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(ok.structured).toMatchObject({
      status: "approved",
      replayed: false,
      proposal: { intentId: 0, decision: "approved", rule: null, trade: { category: "Crypto" } },
      nextAction: { actor: "agent", hint: expect.stringContaining("get_intent") as unknown },
    });
    expect(ok.summary).toMatch(/^Intent #0 approved: buy NO GEMI-BTC2611202200-HI63000 for \$10.00 at 30c/);
    // The executor may be the simulated one on the devchain: never claim where an order was placed.
    expect(ok.summary).toContain("The executor places approved orders.");
    expect(`${ok.summary} ${JSON.stringify(ok.structured["nextAction"])}`).not.toMatch(/on Gemini/);

    const wait = await proposeTrade.run({ ...args, amountCents: 2_200 }, h.ctx);
    expect(wait.structured).toMatchObject({
      status: "held",
      proposal: { intentId: 1, decision: "needs_approval", rule: { rule: "approvalAboveCents" } },
      nextAction: { actor: "owner", hint: expect.stringContaining("#1") as unknown },
    });

    const no = await proposeTrade.run({ ...args, amountCents: 3_000 }, h.ctx);
    expect(no.structured).toMatchObject({
      status: "rejected",
      proposal: { intentId: 2, decision: "rejected", rule: { contractReason: "over max trade size" } },
      reasons: [
        { code: "OVER_MAX_TRADE_SIZE", message: expect.stringContaining("Max trade $25.00") as unknown },
      ],
      nextAction: { actor: "owner", hint: expect.stringContaining("do not retry") as unknown },
    });
    expect(no.summary).toContain("rejected by the mandate (over max trade size)");
  });

  it("sends the category Gemini lists, so a Sports market is rejected onchain", async () => {
    const h = harness();
    const { structured } = await proposeTrade.run(
      { market: SPORTS_SYMBOL, outcome: "YES", amountCents: 500, limitPrice: 55, reason: "Test." },
      h.ctx,
    );
    expect(h.policy.proposed[0]?.category).toBe(Category.Sports);
    expect(structured).toMatchObject({ status: "rejected", reasons: [{ code: "CATEGORY_NOT_ALLOWED" }] });
  });

  it("never trades twice for an identical retry, and says so", async () => {
    const h = harness();
    const first = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    const again = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(h.policy.proposed).toHaveLength(1);
    expect(again.structured).toMatchObject({ replayed: true, proposal: first.structured["proposal"] });
    expect(again.summary).toContain("nothing new was sent");
    // A different reason is a different decision.
    await proposeTrade.run({ ...args, amountCents: 1_000, reason: "Second leg." }, h.ctx);
    expect(h.policy.proposed).toHaveLength(2);
  });

  it("awaits a call still in flight instead of sending a second one", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx),
      proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx),
    ]);
    expect(h.policy.proposed).toHaveLength(1);
    expect([a.structured["replayed"], b.structured["replayed"]].sort()).toEqual([false, true]);
  });

  it("maps chain failures to unavailable verdicts and lets a safe failure be retried", async () => {
    const h = harness();
    h.policy.failNext = new PolicyRevertError("proposeTrade", "NotAgent", new Error("reverted"));
    const notAgent = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(notAgent.structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "NOT_THE_AGENT" }],
      proposal: { intentId: null },
    });

    const retry = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(retry.structured).toMatchObject({ status: "approved", replayed: false });

    h.policy.failNext = new InsufficientFundsError();
    const broke = await proposeTrade.run({ ...args, amountCents: 900 }, h.ctx);
    expect(broke.structured).toMatchObject({
      reasons: [{ code: "AGENT_NEEDS_GAS" }],
      nextAction: { actor: "owner" },
    });
  });

  it("does not resend a proposal that may have reached the chain", async () => {
    const h = harness();
    h.policy.failNext = new PolicyClientError("no receipt for 0xabc after 45000 ms");
    const first = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(first.structured).toMatchObject({ status: "unavailable", reasons: [{ code: "TX_UNCONFIRMED" }] });
    const again = await proposeTrade.run({ ...args, amountCents: 1_000 }, h.ctx);
    expect(again.structured).toMatchObject({ replayed: true, reasons: [{ code: "TX_UNCONFIRMED" }] });
    expect(h.policy.proposed).toHaveLength(0);
  });

  it("answers unavailable without an agent key or a Policy contract", async () => {
    const readOnly = harness({ policy: new FakePolicy({ agentAddress: null }) });
    expect((await proposeTrade.run({ ...args, amountCents: 100 }, readOnly.ctx)).structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "AGENT_KEY_NOT_CONFIGURED" }],
    });
    expect(
      (await proposeTrade.run({ ...args, amountCents: 100 }, harness({ policy: null }).ctx)).structured,
    ).toMatchObject({
      reasons: [{ code: "POLICY_NOT_CONFIGURED" }],
    });
  });

  it("requires a reason", async () => {
    await expect(proposeTrade.run({ ...trade, amountCents: 100 }, harness().ctx)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("decision context (issue #33)", () => {
  const args = {
    ...trade,
    amountCents: 1_000,
    reason: "Owner asked for protection.",
    requestText: "Hedge my BTC",
    signalReceiptIds: ["rcpt_1"],
  };

  it("stores the document under its hash and reports honestly that this contract cannot record it", async () => {
    const h = harness();
    const { structured, summary } = await proposeTrade.run(args, h.ctx);
    const context = (structured["proposal"] as Row)["context"] as Row;
    expect(context).toMatchObject({ stored: true, contextHashRecorded: false });
    const stored = h.console.state.contexts.get(context["hash"] as string);
    expect(stored?.document).toMatchObject({
      version: 1,
      planId: "direct",
      requestText: "Hedge my BTC",
      reason: "Owner asked for protection.",
      signalReceiptIds: ["rcpt_1"],
      ladderSummary: { eventTicker: "BTC2611202200" },
    });
    expect(verifyContext(stored?.document, context["hash"] as string)).toBe(true);
    expect(h.policy.proposed[0]?.contextHash).toBe(context["hash"]);
    expect(summary).toContain("stored offchain only");
  });

  it("reports the hash as recorded when the contract has the contextHash overload", async () => {
    const h = harness();
    h.policy.caps = { previewTrade: true, proposeWithContext: true };
    const { structured, summary } = await proposeTrade.run(args, h.ctx);
    expect(structured).toMatchObject({ proposal: { context: { stored: true, contextHashRecorded: true } } });
    expect(summary).toContain("sealed onchain");
  });

  it("still proposes when the console is down, then delivers the document on the next proposal", async () => {
    const h = harness();
    h.console.setDown(true);
    const first = await proposeTrade.run(args, h.ctx);
    const hash = ((first.structured["proposal"] as Row)["context"] as Row)["hash"] as string;
    expect(first.structured).toMatchObject({ status: "approved", proposal: { context: { stored: false } } });
    h.console.setDown(false);
    await proposeTrade.run({ ...args, reason: "Next leg." }, h.ctx);
    expect(h.console.state.contexts.has(hash)).toBe(true);
    expect(h.ctx.ledger.pendingContexts()).toHaveLength(0);
  });

  it("lets get_intent verify the stored document against the hash", async () => {
    const h = harness();
    h.policy.caps = { previewTrade: true, proposeWithContext: true };
    await proposeTrade.run(args, h.ctx);
    const good = await getIntent.run({ intentId: 0 }, h.ctx);
    expect(good.structured).toMatchObject({
      intent: {
        id: 0,
        status: "approved",
        context: { document: "verified", onchain: true, reason: "Owner asked for protection." },
      },
    });

    // Someone rewrites the stored document: the hash no longer matches.
    const hash = ((good.structured["intent"] as Row)["context"] as Row)["hash"] as string;
    const stored = h.console.state.contexts.get(hash);
    if (stored === undefined) throw new Error("missing");
    h.console.state.contexts.set(hash, {
      ...stored,
      document: { ...stored.document, reason: "Rewritten later." },
    });
    const bad = await getIntent.run({ intentId: 0 }, h.ctx);
    expect(bad.structured).toMatchObject({ intent: { context: { document: "mismatch" } } });
  });
});

describe("get_intent", () => {
  it("returns status, reason and next step, and unavailable for an unknown id", async () => {
    const h = harness();
    await proposeTrade.run({ ...trade, amountCents: 3_000, reason: "Big hedge." }, h.ctx);
    const { structured, summary } = await getIntent.run({ intentId: 0 }, h.ctx);
    expect(structured).toMatchObject({
      status: "ok",
      intent: {
        id: 0,
        status: "rejected",
        statusLabel: "Rejected",
        reason: "over max trade size",
        side: "buy",
        category: "Crypto",
      },
      nextAction: { actor: "owner" },
    });
    expect(summary).toBe(
      "Intent #0: Rejected, buy NO GEMI-BTC2611202200-HI63000 for $30.00 at 30c. Reason: over max trade size.",
    );

    const missing = await getIntent.run({ intentId: 7 }, h.ctx);
    expect(missing.structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "INTENT_NOT_FOUND" }],
    });
  });

  it("shows fills once the executor recorded a result", async () => {
    const h = harness();
    await proposeTrade.run({ ...trade, amountCents: 1_000, reason: "Hedge." }, h.ctx);
    const intent = h.policy.intents[0];
    if (intent === undefined) throw new Error("missing");
    h.policy.intents[0] = { ...intent, status: "executed", filledCents: 990, pnlCents: -990 };
    const { structured, summary } = await getIntent.run({ intentId: 0 }, h.ctx);
    expect(structured).toMatchObject({ intent: { status: "executed", filledCents: 990, pnlCents: -990 } });
    expect(summary).toContain("Filled $9.90, profit -$9.90.");
  });
});

describe("execute_plan", () => {
  const planArgs = {
    asset: "BTC",
    floorCents: 6_200_000,
    maxCostCents: 5_000,
    requestText: "Protect my BTC to $62k.",
  };

  async function plan(h: ReturnType<typeof harness>) {
    const { structured } = await planHedge.run(planArgs, h.ctx);
    return (structured["plan"] as Row)["planId"] as string;
  }

  it("submits every order with a sealed context per rung, and is idempotent", async () => {
    const h = harness();
    const planId = await plan(h);
    const stored = h.ctx.plans.get(planId, h.ctx.clock.now());
    const total = stored?.plan.orders.length ?? 0;
    const { structured, summary } = await executePlan.run(
      { planId, reason: "Owner approved the plan." },
      h.ctx,
    );
    expect(structured).toMatchObject({
      status: "approved",
      execution: {
        planId,
        totalOrders: total,
        submitted: total,
        remaining: 0,
        complete: true,
        stoppedAtOrder: null,
      },
    });
    expect(h.policy.proposed).toHaveLength(total);
    expect(
      h.policy.proposed.every((p) => p.outcome === "NO" && p.isBuy && p.category === Category.Crypto),
    ).toBe(true);
    const hashes = (structured["execution"] as { orders: Row[] }).orders.map(
      (o) => o["contextHash"] as string,
    );
    for (const [index, hash] of hashes.entries()) {
      const doc = h.console.state.contexts.get(hash)?.document;
      expect(doc).toMatchObject({
        planId,
        requestText: "Protect my BTC to $62k.",
        reason: "Owner approved the plan.",
      });
      expect(doc?.rungIndex).toBe(
        (structured["execution"] as { orders: Row[] }).orders[index]?.["rungIndex"],
      );
    }
    expect(summary).toContain(`${total} of ${total} orders submitted`);
    expect(structured).toMatchObject({
      nextAction: { hint: expect.stringMatching(/^The executor places approved orders\./) as unknown },
    });

    const again = await executePlan.run({ planId, reason: "Owner approved the plan." }, h.ctx);
    expect(h.policy.proposed).toHaveLength(total);
    expect(again.structured).toMatchObject({ reasons: [{ code: "ALREADY_EXECUTED" }] });
  });

  it("stops at the first rejection and never sends the orders after it", async () => {
    const h = harness();
    const planId = await plan(h);
    const total = h.ctx.plans.get(planId, h.ctx.clock.now())?.plan.orders.length ?? 0;
    expect(total).toBeGreaterThan(1);
    // The owner tightens the budget after planning: the second order no longer fits.
    const firstAmount = h.ctx.plans.get(planId, h.ctx.clock.now())?.plan.orders[0]?.amountCents ?? 0;
    h.policy.rules.budgetCents = firstAmount;
    const { structured } = await executePlan.run({ planId, reason: "Go." }, h.ctx);
    expect(structured).toMatchObject({
      status: "rejected",
      reasons: [{ code: "PLAN_STOPPED" }],
      execution: { submitted: 2, remaining: 0, complete: true, stoppedAtOrder: 1 },
    });
    expect(h.policy.proposed).toHaveLength(2);
    const orders = (structured["execution"] as { orders: Row[] }).orders;
    expect(orders.map((o) => o["decision"])).toEqual(["approved", "rejected"]);
    expect(orders[1]?.["reason"]).toBe("over budget");
  });

  it("holds when orders wait for the owner", async () => {
    const h = harness();
    h.policy.rules.approvalAboveCents = 500;
    const planId = await plan(h);
    const { structured } = await executePlan.run({ planId, reason: "Go." }, h.ctx);
    expect(structured).toMatchObject({ status: "held", nextAction: { actor: "owner" } });
  });

  it("continues where it stopped after a failure that sent nothing", async () => {
    const h = harness();
    const planId = await plan(h);
    const total = h.ctx.plans.get(planId, h.ctx.clock.now())?.plan.orders.length ?? 0;
    h.policy.failNext = new PolicyClientError("RPC went away");
    const failed = await executePlan.run({ planId, reason: "Go." }, h.ctx);
    expect(failed.structured).toMatchObject({ status: "unavailable", execution: { submitted: 0 } });
    const resumed = await executePlan.run({ planId, reason: "Go." }, h.ctx);
    expect(resumed.structured).toMatchObject({ status: "approved", execution: { submitted: total } });
    expect(h.policy.proposed).toHaveLength(total);
  });

  it("refuses unknown and stale plans", async () => {
    const h = harness();
    expect((await executePlan.run({ planId: "plan_nope", reason: "Go." }, h.ctx)).structured).toMatchObject({
      status: "unavailable",
      reasons: [{ code: "PLAN_NOT_FOUND" }],
    });
    const planId = await plan(h);
    const later = { ...h.ctx, clock: { now: () => new Date(h.ctx.clock.now().getTime() + 31 * 60_000) } };
    expect((await executePlan.run({ planId, reason: "Go." }, later)).structured).toMatchObject({
      reasons: [{ code: "PLAN_EXPIRED" }],
    });
    expect(h.policy.proposed).toHaveLength(0);
  });

  it("does not let a Sports-only mandate execute a crypto plan", async () => {
    const h = harness();
    const planId = await plan(h);
    h.policy.rules.allowedCategories = categoryMask([Category.Sports]);
    const { structured } = await executePlan.run({ planId, reason: "Go." }, h.ctx);
    expect(structured).toMatchObject({ status: "rejected", execution: { submitted: 1, stoppedAtOrder: 0 } });
  });
});
