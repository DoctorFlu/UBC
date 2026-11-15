import * as z from "zod";
import { formatCents, headroom, type PolicySnapshot, type PreviewResult } from "@mandate/shared";
import { ok, summarizeVerdict, verdictSchema, type NextAction } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { tradeArgs } from "../support/format";
import {
  AFTER_REJECTION,
  approvalHit,
  hitReason,
  rejectionHit,
  RuleHitSchema,
  type RuleHit,
} from "../support/rules";
import { resolveTradeMarket } from "../trading/market";
import { TradeSchema, tradeView } from "../trading/propose";

const SimulationSchema = z.object({
  wouldBe: z.enum(["approved", "needs_approval", "rejected"]),
  source: z
    .enum(["contract", "offchain"])
    .describe(
      "contract: the contract's own previewTrade answered. offchain: the server's exact copy of the rules on a fresh snapshot",
    ),
  rule: RuleHitSchema.nullable().describe("The rule that would stop or hold the trade"),
  trade: TradeSchema,
  headroom: z.object({ remainingBudgetCents: z.int(), maxNextBuyCents: z.int(), maxNextSellCents: z.int() }),
});

function nextFor(wouldBe: PreviewResult["verdict"]): NextAction {
  switch (wouldBe) {
    case "approved":
      return {
        actor: "agent",
        hint: "Call propose_trade with the same arguments and the reason for the trade.",
      };
    case "needs_approval":
      return {
        actor: "agent",
        hint: "If you propose it, it will wait for the owner's approval; tell the owner before calling propose_trade.",
      };
    case "rejected":
      return AFTER_REJECTION;
  }
}

export const simulateTrade = defineTool({
  name: "simulate_trade",
  title: "Check a trade against the mandate",
  description:
    "Asks whether a trade would pass the mandate right now, without sending anything: approved, waiting for the owner's approval, or rejected, and which rule would stop it, with the numbers. Uses the contract's own previewTrade when the deployed contract has it, otherwise an exact copy of the rules on a fresh snapshot (the result says which). The market's category is read from Gemini. Call it before propose_trade.",
  inputSchema: z.object({
    market: tradeArgs.market,
    outcome: tradeArgs.outcome,
    side: tradeArgs.side,
    amountCents: tradeArgs.amountCents,
    limitPrice: tradeArgs.limitPrice,
  }),
  outputSchema: verdictSchema({ simulation: SimulationSchema.nullable() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.policy === undefined) {
      const v = unavailableFor(notConfigured.policy());
      return { structured: { ...v, simulation: null }, summary: summarizeVerdict(v) };
    }
    const resolved = await resolveTradeMarket(ctx, input.market);
    if (resolved.failure !== undefined) {
      const v = unavailableFor(resolved.failure);
      return { structured: { ...v, simulation: null }, summary: summarizeVerdict(v) };
    }
    const isBuy = input.side === "buy";
    const categoryId = resolved.market.categoryId;
    let preview: PreviewResult;
    let snapshot: PolicySnapshot;
    try {
      [preview, snapshot] = await Promise.all([
        ctx.policy.preview({ category: categoryId, isBuy, amountCents: input.amountCents }),
        ctx.policy.snapshot(),
      ]);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, simulation: null }, summary: summarizeVerdict(v) };
    }

    const trade = { category: categoryId, isBuy, amountCents: input.amountCents };
    const rule: RuleHit | null =
      preview.verdict === "rejected"
        ? rejectionHit(preview.reason, { rules: snapshot.rules, state: snapshot, trade })
        : preview.verdict === "needs_approval"
          ? approvalHit(snapshot.rules, input.amountCents)
          : null;
    const room = headroom(snapshot.rules, snapshot);
    const v = ok(rule === null ? [] : [hitReason(rule)], nextFor(preview.verdict));
    const how =
      preview.source === "contract" ? "the contract's previewTrade" : "the server's copy of the rules";
    const outcome =
      preview.verdict === "approved"
        ? "would be approved"
        : preview.verdict === "needs_approval"
          ? "would wait for the owner's approval"
          : "would be rejected";
    return {
      structured: {
        ...v,
        simulation: {
          wouldBe: preview.verdict,
          source: preview.source,
          rule,
          trade: tradeView({
            market: input.market,
            outcome: input.outcome,
            isBuy,
            amountCents: input.amountCents,
            limitPrice: input.limitPrice,
            categoryId,
          }),
          headroom: {
            remainingBudgetCents: room.remainingBudgetCents,
            maxNextBuyCents: room.maxNextBuyCents,
            maxNextSellCents: room.maxNextSellCents,
          },
        },
      },
      summary: `Simulated with ${how}: a ${formatCents(input.amountCents)} ${input.side} ${outcome}.${
        rule === null ? "" : ` ${rule.explanation}${rule.detail === null ? "" : ` ${rule.detail}`}`
      } Nothing was sent.`,
    };
  },
});
