import * as z from "zod";
import { formatCents } from "@mandate/shared";
import type { ToolContext } from "../context";
import {
  approved,
  held,
  ok,
  reason,
  rejected,
  summarizeVerdict,
  unavailable,
  verdictDetails,
  verdictSchema,
  type Reason,
  type Verdict,
} from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import type { AgentPolicy } from "../services";
import { PLAN_EXECUTABLE_FOR_MS, type OrderOutcome, type StoredPlan } from "../state/plans";
import { notConfigured, unavailableFor, type Failure } from "../support/failures";
import { AFTER_REJECTION } from "../support/rules";
import { proposeIntent } from "../trading/propose";
import { decisionReasonArg, signalReceiptIdsArg } from "./propose-trade";

/** Stop starting new orders after this long, so one call stays inside the client's patience. */
export const EXECUTION_BUDGET_MS = 40_000;
const MAX_ROWS = 20;

const OrderRowSchema = z.object({
  orderIndex: z.int(),
  rungIndex: z.int(),
  instrumentSymbol: z.string(),
  amountCents: z.int(),
  limitPrice: z.int(),
  decision: z.enum(["approved", "needs_approval", "rejected", "error"]),
  intentId: z.int().nullable(),
  reason: z.string().nullable().describe("The contract's rejection reason or an error code"),
  txHash: z.string().nullable(),
  contextHash: z.string().nullable(),
});

const ExecutionSchema = z.object({
  planId: z.string(),
  totalOrders: z.int(),
  submitted: z.int().describe("Orders that have an answer from the contract"),
  remaining: z.int().describe("Orders not submitted yet"),
  complete: z.boolean().describe("Every order has an answer, or execution stopped at a rejection"),
  stoppedAtOrder: z.int().nullable().describe("The order the mandate rejected; later orders are never sent"),
  contextHashRecorded: z
    .boolean()
    .nullable()
    .describe("Decision-context hashes are onchain (null before any order)"),
  orders: z.array(OrderRowSchema),
  ordersTruncated: z.boolean(),
});
type Execution = z.infer<typeof ExecutionSchema>;

function executionView(stored: StoredPlan, recorded: boolean | null): Execution {
  const total = stored.plan.orders.length;
  const rows = stored.outcomes.slice(-MAX_ROWS);
  return {
    planId: stored.plan.planId,
    totalOrders: total,
    submitted: stored.outcomes.length,
    remaining: stored.stoppedAt === null ? total - stored.outcomes.length : 0,
    complete: stored.stoppedAt !== null || stored.outcomes.length === total,
    stoppedAtOrder: stored.stoppedAt,
    contextHashRecorded: recorded,
    orders: rows,
    ordersTruncated: rows.length < stored.outcomes.length,
  };
}

/** Submits the plan's orders from where it left off. Returns why it stopped early, if it did. */
async function runOrders(
  ctx: ToolContext,
  policy: AgentPolicy,
  stored: StoredPlan,
  input: { reason: string; signalReceiptIds: string[] },
): Promise<{ failure: Failure | null; recorded: boolean | null; outOfTime: boolean }> {
  const started = Date.now();
  let recorded: boolean | null = null;
  const { plan } = stored;
  while (stored.stoppedAt === null && stored.outcomes.length < plan.orders.length) {
    if (Date.now() - started > EXECUTION_BUDGET_MS) return { failure: null, recorded, outOfTime: true };
    const orderIndex = stored.outcomes.length;
    const order = plan.orders[orderIndex];
    if (order === undefined) break;
    const rungIndex = Math.max(
      0,
      plan.rungs.findIndex((r) => r.instrumentSymbol === order.instrumentSymbol),
    );
    const outcome = await proposeIntent(
      ctx,
      policy,
      {
        market: order.instrumentSymbol,
        outcome: "NO",
        isBuy: true,
        amountCents: order.amountCents,
        limitPrice: order.limitPriceCents,
        categoryId: stored.categoryId,
      },
      {
        requestText: stored.requestText,
        planId: plan.planId,
        rungIndex,
        ladderSummary: stored.ladderSummary,
        signalReceiptIds: input.signalReceiptIds,
        reason: input.reason,
      },
    );
    const base: Omit<OrderOutcome, "decision" | "intentId" | "reason" | "txHash"> = {
      orderIndex,
      rungIndex,
      instrumentSymbol: order.instrumentSymbol,
      amountCents: order.amountCents,
      limitPrice: order.limitPriceCents,
      contextHash:
        outcome.proposal.context === null ? null : (outcome.proposal.context.hash as `0x${string}`),
    };
    if (outcome.kind === "failed") {
      // Nothing reached the chain, so the next call can retry this order, unless it may have.
      if (outcome.failure.reason.code === "TX_UNCONFIRMED") {
        stored.outcomes.push({
          ...base,
          decision: "error",
          intentId: null,
          reason: "TX_UNCONFIRMED",
          txHash: null,
        });
        stored.stoppedAt = orderIndex;
      }
      return { failure: outcome.failure, recorded, outOfTime: false };
    }
    recorded = outcome.result.contextHashRecorded;
    stored.outcomes.push({
      ...base,
      decision: outcome.result.verdict,
      intentId: outcome.result.intentId,
      reason: outcome.result.verdict === "rejected" ? outcome.result.reason : null,
      txHash: outcome.result.txHash,
    });
    if (outcome.result.verdict === "rejected") stored.stoppedAt = orderIndex;
  }
  return { failure: null, recorded, outOfTime: false };
}

function verdictFor(
  stored: StoredPlan,
  failure: Failure | null,
  outOfTime: boolean,
  replayed: boolean,
): Verdict {
  const outcomes = stored.outcomes;
  const stopped = stored.stoppedAt === null ? undefined : outcomes[stored.stoppedAt];
  if (stopped?.decision === "rejected") {
    return rejected(
      [
        reason(
          "PLAN_STOPPED",
          `Order ${stopped.orderIndex} was rejected by the mandate (${stopped.reason ?? "no reason"}); the orders after it were not sent.`,
        ),
      ],
      AFTER_REJECTION,
    );
  }
  if (failure !== null) return unavailableFor(failure);
  if (stopped?.decision === "error") {
    return unavailable(
      [
        reason(
          "TX_UNCONFIRMED",
          "An order was sent but not confirmed; execution stopped to avoid sending it twice.",
        ),
      ],
      {
        actor: "agent",
        hint: "Call get_activity to see whether it landed, then tell the owner.",
      },
    );
  }
  if (outOfTime) {
    return ok([reason("IN_PROGRESS", "Some orders are not submitted yet.")], {
      actor: "agent",
      hint: `Call execute_plan again with planId ${stored.plan.planId} to continue; orders already sent are never sent twice.`,
    });
  }
  const waiting = outcomes.filter((o) => o.decision === "needs_approval");
  const reasons: Reason[] = replayed
    ? [reason("ALREADY_EXECUTED", "This plan was executed before; these are the recorded results.")]
    : [];
  if (waiting.length > 0) {
    return held(
      [
        ...reasons,
        reason("OWNER_APPROVAL_REQUIRED", `${waiting.length} orders wait for the owner's approval.`),
      ],
      {
        actor: "owner",
        hint: `Approve or reject intents ${waiting.map((o) => `#${o.intentId ?? "?"}`).join(", ")} in the console.`,
      },
    );
  }
  return approved(reasons, {
    actor: "agent",
    hint: "The executor places approved orders on Gemini. Call get_activity later to report fills to the owner.",
  });
}

export const executePlan = defineTool({
  name: "execute_plan",
  title: "Execute a hedge plan",
  description:
    "Submits the orders of a plan from plan_hedge to the Policy contract, one intent per order, in order, and reports the mandate's answer for each. It stops at the first rejection and never sends the orders after it. Orders above the approval threshold wait for the owner. Calling it again with the same planId continues where it stopped or returns the recorded results; it never sends an order twice. Plans can be executed for 30 minutes after planning. Get the owner's agreement first.",
  inputSchema: z.object({
    planId: z.string().trim().min(1).max(128).describe("The planId plan_hedge returned"),
    reason: decisionReasonArg,
    signalReceiptIds: signalReceiptIdsArg,
  }),
  outputSchema: verdictSchema({ execution: ExecutionSchema.nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  timeoutMs: 90_000,
  handler: async (input, ctx) => {
    const policy = ctx.policy;
    if (policy === undefined || policy.agentAddress === undefined) {
      const v = unavailableFor(policy === undefined ? notConfigured.policy() : notConfigured.agentKey());
      return { structured: { ...v, execution: null }, summary: summarizeVerdict(v) };
    }
    const now = ctx.clock.now();
    const stored = ctx.plans.get(input.planId, now);
    if (stored === undefined) {
      const v = unavailable([reason("PLAN_NOT_FOUND", `This server has no plan ${input.planId}.`)], {
        actor: "agent",
        hint: "Call plan_hedge again: plans are kept for a few hours and are lost when the server restarts.",
      });
      return { structured: { ...v, execution: null }, summary: summarizeVerdict(v) };
    }
    const fresh = now.getTime() - stored.createdAt.getTime() <= PLAN_EXECUTABLE_FOR_MS;
    if (stored.outcomes.length === 0 && !fresh) {
      const v = unavailable(
        [reason("PLAN_EXPIRED", "This plan is more than 30 minutes old and its prices are stale.")],
        {
          actor: "agent",
          hint: "Call plan_hedge again with the same goal, show the owner the new plan, then execute that one.",
        },
      );
      return { structured: { ...v, execution: null }, summary: summarizeVerdict(v) };
    }
    if (stored.plan.orders.length === 0) {
      const v = ok([reason("PLAN_EMPTY", "This plan has no orders.")], {
        actor: "agent",
        hint: "Tell the owner nothing was bought, and why (see plan_hedge's warnings).",
      });
      return { structured: { ...v, execution: executionView(stored, null) }, summary: summarizeVerdict(v) };
    }

    return ctx.plans.exclusive(stored.plan.planId, async () => {
      const already = stored.stoppedAt !== null || stored.outcomes.length === stored.plan.orders.length;
      const run =
        already || !fresh
          ? { failure: null, recorded: null, outOfTime: false }
          : await runOrders(ctx, policy, stored, input);
      const v =
        !already && !fresh
          ? unavailable(
              [
                reason(
                  "PLAN_EXPIRED",
                  "The rest of this plan is more than 30 minutes old and its prices are stale.",
                ),
              ],
              {
                actor: "agent",
                hint: "Tell the owner which orders went through, then call plan_hedge again for the rest.",
              },
            )
          : verdictFor(stored, run.failure, run.outOfTime, already);
      const recorded =
        run.recorded ??
        (stored.outcomes.length === 0
          ? null
          : (ctx.ledger.lookup(stored.outcomes[0]?.intentId ?? -1)?.contextHashRecorded ?? null));
      const execution = executionView(stored, recorded);
      const tally = (d: OrderOutcome["decision"]) => stored.outcomes.filter((o) => o.decision === d).length;
      const spent = stored.outcomes
        .filter((o) => o.decision === "approved")
        .reduce((sum, o) => sum + o.amountCents, 0);
      const counts = `${execution.submitted} of ${execution.totalOrders} orders submitted: ${tally("approved")} approved (${formatCents(spent)}), ${tally("needs_approval")} waiting for the owner, ${tally("rejected")} rejected.`;
      return {
        structured: { ...v, execution },
        summary: [`Plan ${stored.plan.planId}: ${counts}`, verdictDetails(v)]
          .filter((part) => part !== "")
          .join(" "),
      };
    });
  },
});
