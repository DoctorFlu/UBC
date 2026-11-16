/**
 * The one path to the contract's `proposeTrade`, shared by `propose_trade` and `execute_plan`:
 * seal the decision context, submit the intent from the agent key, and turn the contract's answer
 * into a verdict the agent can explain.
 */
import * as z from "zod";
import {
  categoryLabel,
  type CategoryId,
  type DecisionContext,
  type Outcome,
  type ProposeResult,
} from "@mandate/shared";
import type { ToolContext } from "../context";
import { approved, held, rejected, type Verdict } from "../mcp/envelope";
import type { AgentPolicy } from "../services";
import { describeFailure, type Failure } from "../support/failures";
import {
  AFTER_REJECTION,
  approvalHit,
  hitReason,
  rejectionHit,
  RuleHitSchema,
  type RuleHit,
} from "../support/rules";
import { linkContext, sealContext, type SealedContext } from "./context";

export interface TradeSpec {
  market: string;
  outcome: Outcome;
  isBuy: boolean;
  amountCents: number;
  limitPrice: number;
  categoryId: CategoryId;
}

export const TradeSchema = z.object({
  market: z.string().describe("Gemini instrumentSymbol"),
  outcome: z.enum(["YES", "NO"]),
  side: z.enum(["buy", "sell"]),
  amountCents: z.int(),
  limitPrice: z.int().describe("Cents per $1 contract"),
  category: z.string().describe("Mandate category, read from Gemini"),
});

export const ContextReceiptSchema = z.object({
  hash: z.string().describe("keccak256 of the canonical decision-context document"),
  stored: z.boolean().describe("The console has the document (if false, the server retries later)"),
  contextHashRecorded: z
    .boolean()
    .describe("The hash is onchain with the intent. False when the deployed contract cannot record it"),
  contextLinked: z
    .boolean()
    .nullable()
    .describe(
      "The console links the intent to this document, so the owner sees why. False: not yet (the server retries) or refused; null: no console or no intent",
    ),
});

export const ProposalSchema = z.object({
  intentId: z
    .int()
    .nullable()
    .describe("Onchain intent id (ids start at 0), or null if nothing was recorded"),
  decision: z
    .enum(["approved", "needs_approval", "rejected"])
    .nullable()
    .describe("The contract's verdict, or null if the proposal could not be submitted"),
  rule: RuleHitSchema.nullable().describe("The rule behind a rejection or a hold"),
  trade: TradeSchema,
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  context: ContextReceiptSchema.nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export type ProposalOutcome =
  | { kind: "submitted"; proposal: Proposal; verdict: Verdict; result: ProposeResult }
  | { kind: "failed"; proposal: Proposal; failure: Failure };

export function tradeView(trade: TradeSpec): z.infer<typeof TradeSchema> {
  return {
    market: trade.market,
    outcome: trade.outcome,
    side: trade.isBuy ? "buy" : "sell",
    amountCents: trade.amountCents,
    limitPrice: trade.limitPrice,
    category: categoryLabel(trade.categoryId),
  };
}

/**
 * Seals the context, proposes, links the new intent to its context in the console, and maps the
 * contract's answer. Never throws for an expected failure. `linkContext: false` only queues the link,
 * for a caller that just saw the console fail and must not wait for it again.
 */
export async function proposeIntent(
  ctx: ToolContext,
  policy: AgentPolicy,
  trade: TradeSpec,
  context: Omit<DecisionContext, "version" | "createdAt">,
  options: { linkContext?: boolean } = {},
): Promise<ProposalOutcome> {
  const sealed = await sealContext(ctx, context);
  const base = {
    trade: tradeView(trade),
    context: {
      hash: sealed.hash,
      stored: sealed.stored,
      contextHashRecorded: false,
      contextLinked: null as boolean | null,
    },
  };

  let result: ProposeResult;
  try {
    result = await policy.propose({
      market: trade.market,
      category: trade.categoryId,
      outcome: trade.outcome,
      isBuy: trade.isBuy,
      amountCents: trade.amountCents,
      limitPrice: trade.limitPrice,
      contextHash: sealed.hash,
    });
  } catch (error) {
    const failure = describeFailure(error, ctx);
    return {
      kind: "failed",
      failure,
      proposal: { ...base, intentId: null, decision: null, rule: null, txHash: null, explorerUrl: null },
    };
  }

  ctx.ledger.remember(result.intentId, {
    contextHash: sealed.hash,
    contextStored: sealed.stored,
    contextHashRecorded: result.contextHashRecorded,
    contextLinked: ctx.console === undefined ? null : false,
    planId: context.planId,
    reason: context.reason,
  });
  ctx.logger.info("intent.proposed", {
    intentId: result.intentId,
    verdict: result.verdict,
    contextHashRecorded: result.contextHashRecorded,
    contextStored: sealed.stored,
  });
  // After the transaction is confirmed and the id is known. Best effort: it never changes the verdict.
  const contextLinked = await linkContext(
    ctx,
    result.intentId,
    { hash: sealed.hash, txHash: result.txHash },
    { attempt: options.linkContext !== false },
  );

  const rule = await ruleFor(policy, result, trade);
  const proposal: Proposal = {
    ...base,
    intentId: result.intentId,
    decision: result.verdict,
    rule,
    txHash: result.txHash,
    explorerUrl: policy.explorerTxUrl(result.txHash),
    context: { ...base.context, contextHashRecorded: result.contextHashRecorded, contextLinked },
  };
  return { kind: "submitted", proposal, result, verdict: verdictOf(result, rule) };
}

function verdictOf(result: ProposeResult, rule: RuleHit | null): Verdict {
  switch (result.verdict) {
    case "approved":
      return approved([], {
        actor: "agent",
        hint: `The executor places approved orders. Call get_intent with intentId ${result.intentId} later to see whether it filled.`,
      });
    case "needs_approval":
      return held(rule === null ? [] : [hitReason(rule)], {
        actor: "owner",
        hint: `Approve or reject intent #${result.intentId} in the console. Then the agent can call get_intent to see the outcome.`,
      });
    case "rejected":
      return rejected(rule === null ? [] : [hitReason(rule)], AFTER_REJECTION);
  }
}

/** The rule behind a rejection or hold, with numbers read right after the proposal. */
async function ruleFor(
  policy: AgentPolicy,
  result: ProposeResult,
  trade: TradeSpec,
): Promise<RuleHit | null> {
  if (result.verdict === "approved") return null;
  const snapshot = await policy.snapshot().catch(() => undefined);
  if (result.verdict === "needs_approval") return approvalHit(snapshot?.rules, trade.amountCents);
  return rejectionHit(
    result.reason,
    snapshot === undefined
      ? undefined
      : {
          rules: snapshot.rules,
          state: snapshot,
          trade: { category: trade.categoryId, isBuy: trade.isBuy, amountCents: trade.amountCents },
        },
  );
}

export type { SealedContext };
