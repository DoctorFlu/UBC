import * as z from "zod";
import { formatCents } from "@mandate/shared";
import { summarizeVerdict, verdictSchema, type Verdict } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import type { DecisionContext } from "@mandate/shared";
import { notConfigured, unavailableFor } from "../support/failures";
import { tradeArgs } from "../support/format";
import { DIRECT_PLAN_ID, ladderSummaryFromEvent, relinkContext } from "../trading/context";
import { resolveTradeMarket } from "../trading/market";
import { proposeIntent, ProposalSchema, type Proposal, type ProposalOutcome } from "../trading/propose";

export const signalReceiptIdsArg = z
  .array(z.string().trim().min(1).max(200))
  .max(10)
  .default([])
  .describe("Receipt ids of paid signals that informed this decision, from buy_signal");

export const decisionReasonArg = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe(
    "Why you are doing this, in one or two sentences for the owner. It is sealed into the intent's decision context",
  );

/** Outcomes safe to repeat are not replayed; anything that may have reached the chain is. */
function keepForReplay(outcome: ProposalOutcome): boolean {
  return outcome.kind === "submitted" || outcome.failure.reason.code === "TX_UNCONFIRMED";
}

function describe(proposal: Proposal, verdict: Verdict): string {
  const { trade } = proposal;
  const what = `${trade.side} ${trade.outcome} ${trade.market} for ${formatCents(trade.amountCents)} at ${trade.limitPrice}c`;
  const context =
    proposal.context === null
      ? ""
      : proposal.context.contextHashRecorded
        ? " Decision context sealed onchain."
        : " Decision context stored offchain only (this contract cannot record its hash).";
  switch (proposal.decision) {
    case "approved":
      return `Intent #${proposal.intentId ?? "?"} approved: ${what}. The executor places approved orders.${context}`;
    case "needs_approval":
      return `Intent #${proposal.intentId ?? "?"} is waiting for the owner's approval: ${what}. ${proposal.rule?.detail ?? ""}${context}`.trim();
    case "rejected":
      return `Intent #${proposal.intentId ?? "?"} rejected by the mandate (${proposal.rule?.contractReason ?? "no reason"}): ${what}. ${proposal.rule?.explanation ?? ""} ${proposal.rule?.detail ?? ""}`.trim();
    case null:
      return summarizeVerdict(verdict);
  }
}

export const proposeTrade = defineTool({
  name: "propose_trade",
  title: "Propose one trade",
  description:
    "Submits one trade intent to the Policy contract from the agent's key: the only way to trade. The contract answers approved (the executor then places the order on Gemini), held (waiting for the owner's approval in the console) or rejected with the rule that stopped it. A rejection is a final answer: explain it to the owner, never retry, resize or split. Call simulate_trade first. The category is read from Gemini. Your reason is sealed into a decision-context document whose hash goes onchain with the intent. An identical call within 10 minutes returns the first result instead of trading twice.",
  inputSchema: z.object({
    market: tradeArgs.market,
    outcome: tradeArgs.outcome,
    side: tradeArgs.side,
    amountCents: tradeArgs.amountCents,
    limitPrice: tradeArgs.limitPrice,
    reason: decisionReasonArg,
    requestText: z.string().trim().max(2000).default("").describe("The owner's request in their own words"),
    signalReceiptIds: signalReceiptIdsArg,
  }),
  outputSchema: verdictSchema({
    proposal: ProposalSchema.nullable(),
    replayed: z.boolean().describe("True when this repeats an identical earlier call; nothing new was sent"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  timeoutMs: 60_000,
  handler: async (input, ctx) => {
    const policy = ctx.policy;
    if (policy === undefined || policy.agentAddress === undefined) {
      const v = unavailableFor(policy === undefined ? notConfigured.policy() : notConfigured.agentKey());
      return { structured: { ...v, proposal: null, replayed: false }, summary: summarizeVerdict(v) };
    }
    const isBuy = input.side === "buy";
    const key = JSON.stringify([
      input.market,
      input.outcome,
      isBuy,
      input.amountCents,
      input.limitPrice,
      input.reason,
    ]);

    const {
      value: outcome,
      replayed,
      firstAt,
    } = await ctx.ledger.once(
      key,
      ctx.clock.now(),
      async (): Promise<ProposalOutcome | { kind: "unresolved"; verdict: Verdict }> => {
        const resolved = await resolveTradeMarket(ctx, input.market);
        if (resolved.failure !== undefined)
          return { kind: "unresolved", verdict: unavailableFor(resolved.failure) };
        const context: Omit<DecisionContext, "version" | "createdAt"> = {
          requestText: input.requestText,
          planId: DIRECT_PLAN_ID,
          rungIndex: Math.max(
            0,
            resolved.market.event.contracts.findIndex((c) => c.instrumentSymbol === input.market),
          ),
          ladderSummary: ladderSummaryFromEvent(resolved.market.event, ctx.clock.now().toISOString()),
          signalReceiptIds: input.signalReceiptIds,
          reason: input.reason,
        };
        return proposeIntent(
          ctx,
          policy,
          {
            market: input.market,
            outcome: input.outcome,
            isBuy,
            amountCents: input.amountCents,
            limitPrice: input.limitPrice,
            categoryId: resolved.market.categoryId,
          },
          context,
        );
      },
      (result) => result.kind !== "unresolved" && keepForReplay(result),
    );

    if (outcome.kind === "unresolved") {
      return {
        structured: { ...outcome.verdict, proposal: null, replayed },
        summary: summarizeVerdict(outcome.verdict),
      };
    }
    // A replay sends nothing new to the chain, but may finish linking the intent in the console.
    const { proposal } = outcome;
    if (replayed && proposal.intentId !== null && proposal.context?.contextLinked === false) {
      proposal.context.contextLinked = await relinkContext(ctx, proposal.intentId, false);
    }
    const verdict = outcome.kind === "submitted" ? outcome.verdict : unavailableFor(outcome.failure);
    const again = replayed
      ? ` (Repeat of an identical call from ${Math.round((ctx.clock.now().getTime() - firstAt.getTime()) / 1000)} s ago; nothing new was sent.)`
      : "";
    return {
      structured: { ...verdict, proposal: outcome.proposal, replayed },
      summary: `${describe(outcome.proposal, verdict)}${again}`,
    };
  },
});
