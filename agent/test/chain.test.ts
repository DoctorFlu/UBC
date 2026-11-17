/**
 * The trading tools against real Policy contracts on anvil: the production `Policy.sol` as is, and
 * the reference contract. Both have the requested extensions (`previewTrade`, the `contextHash`
 * overload, `IntentProposed`), the production contract since v2 (issue #23), so the tools answer the
 * same on both. Markets and the console are faked; the chain is not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devPrivateKey, startDevchain, type Devchain, type PolicyContractKind } from "@mandate/devchain";
import { verifyContext } from "@mandate/shared";
import { createAgentPolicy } from "../src/chain/agent-policy";
import type { ToolContext } from "../src/context";
import { executePlan } from "../src/tools/execute-plan";
import { getActivity } from "../src/tools/get-activity";
import { getIntent } from "../src/tools/get-intent";
import { getPolicy } from "../src/tools/get-policy";
import { getSetupState } from "../src/tools/get-setup-state";
import { planHedge } from "../src/tools/plan-hedge";
import { proposeTrade } from "../src/tools/propose-trade";
import { simulateTrade } from "../src/tools/simulate-trade";
import { harness, ladderSymbol, type Harness } from "./fakes";

type Row = Record<string, unknown>;
const MARKET = ladderSymbol(63_000);
const trade = { market: MARKET, outcome: "NO" as const, limitPrice: 30, reason: "Demo case." };

describe.each<PolicyContractKind>(["production", "reference"])("tools on the %s contract", (contract) => {
  let chain: Devchain;
  let h: Harness;
  let ctx: ToolContext;

  beforeAll(async () => {
    chain = await startDevchain({ contract, port: 0 });
    h = harness({
      env: {
        ARC_RPC_URL: chain.rpcUrl,
        POLICY_ADDRESS: chain.deployment.address,
        POLICY_DEPLOY_BLOCK: chain.deployment.blockNumber.toString(),
        AGENT_PRIVATE_KEY: devPrivateKey("agent"),
      },
    });
    ctx = { ...h.ctx, policy: createAgentPolicy(h.ctx.config) };
  });
  afterAll(async () => {
    await chain.stop();
  });

  it("reads the mandate and finds this key is the contract's agent", async () => {
    const { structured } = await getPolicy.run({}, ctx);
    expect(structured).toMatchObject({
      status: "ok",
      policy: {
        rules: { budgetCents: 20_000, maxTradeCents: 2_500, allowedCategories: ["Crypto"] },
        contract: { previewTrade: true, contextHash: true },
        agent: { isContractAgent: true },
      },
    });
    const setup = await getSetupState.run({}, ctx);
    const chainSteps = (setup.structured["steps"] as Row[]).filter((s) =>
      ["chain_reachable", "agent_role", "agent_gas", "mandate_rules", "not_paused"].includes(
        s["key"] as string,
      ),
    );
    expect(chainSteps.every((s) => s["done"] === true)).toBe(true);
  });

  it("simulates with the contract's previewTrade", async () => {
    const { structured } = await simulateTrade.run({ ...trade, amountCents: 3_000 }, ctx);
    expect(structured).toMatchObject({
      simulation: {
        wouldBe: "rejected",
        source: "contract",
        rule: { rule: "maxTradeCents" },
      },
    });
  });

  it("gives the three demo verdicts with sealed contexts", async () => {
    const approved = await proposeTrade.run({ ...trade, amountCents: 1_000 }, ctx);
    const held = await proposeTrade.run({ ...trade, amountCents: 2_200 }, ctx);
    const rejected = await proposeTrade.run({ ...trade, amountCents: 3_000 }, ctx);
    expect(approved.structured).toMatchObject({ status: "approved", proposal: { intentId: 0 } });
    expect(held.structured).toMatchObject({
      status: "held",
      proposal: { intentId: 1, decision: "needs_approval" },
    });
    expect(rejected.structured).toMatchObject({
      status: "rejected",
      proposal: {
        intentId: 2,
        rule: { contractReason: "over max trade size", detail: "Max trade $25.00; this trade $30.00." },
      },
    });
    for (const result of [approved, held, rejected]) {
      const context = (result.structured["proposal"] as Row)["context"] as Row;
      expect(context).toMatchObject({ stored: true, contextHashRecorded: true });
      const doc = h.console.state.contexts.get(context["hash"] as string)?.document;
      expect(verifyContext(doc, context["hash"] as string)).toBe(true);
    }
  });

  it("reports activity with the contract's reasons, read from events", async () => {
    const { structured } = await getActivity.run({}, ctx);
    const intents = structured["intents"] as Row[];
    expect(intents.map((i) => [i["id"], i["status"], i["reason"]])).toEqual([
      [2, "rejected", "over max trade size"],
      [1, "needs_approval", null],
      [0, "approved", null],
    ]);
  });

  it("verifies the decision context of an intent", async () => {
    const { structured } = await getIntent.run({ intentId: 0 }, ctx);
    expect(structured).toMatchObject({
      intent: { id: 0, status: "approved", context: { document: "verified", onchain: true } },
    });
  });

  it("executes a plan rung by rung", async () => {
    // The demo intents above already hold 106.66 NO at $63,000, which covers a goal down to $62,000;
    // down to $61,000 the plan buys only what they leave missing.
    const planned = await planHedge.run(
      { asset: "BTC", floorCents: 6_100_000, maxCostCents: 5_000, requestText: "Protect my BTC to $61k." },
      ctx,
    );
    expect(planned.structured).toMatchObject({
      plan: { cover: { state: "partly_met", heldPayoutCents: 10_666, targetPayoutCents: 15_000 } },
    });
    const plan = planned.structured["plan"] as { planId: string; orders: Row[] };
    const { structured } = await executePlan.run({ planId: plan.planId, reason: "Owner agreed." }, ctx);
    expect(structured).toMatchObject({
      status: "approved",
      execution: {
        totalOrders: plan.orders.length,
        submitted: plan.orders.length,
        contextHashRecorded: true,
      },
    });
    const intent = await ctx.policy?.intent(3);
    expect(intent).toMatchObject({
      market: plan.orders[0]?.["instrumentSymbol"],
      outcome: "NO",
      isBuy: true,
      category: 0,
    });
  });
});
