import * as z from "zod";
import type { HedgePlan } from "@mandate/planner";
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
import { PROPOSAL_RESERVE_MS, reserveWithin } from "../mcp/scoped-services";
import { defineTool } from "../mcp/tool";
import type { AgentPolicy, MarketsClient } from "../services";
import { ladderLockKey, PLAN_EXECUTABLE_FOR_MS, type OrderOutcome, type StoredPlan } from "../state/plans";
import {
  describeFailure,
  NOT_STARTED,
  notConfigured,
  stoppedFailure,
  TIMED_OUT,
  unavailableFor,
  type Failure,
} from "../support/failures";
import { AFTER_REJECTION } from "../support/rules";
import { linkPending, relinkContext } from "../trading/context";
import { heldPositions } from "../trading/positions";
import { proposeIntent } from "../trading/propose";
import { decisionReasonArg, signalReceiptIdsArg } from "./propose-trade";

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
  contextLinked: z
    .boolean()
    .nullable()
    .describe("The console links the intent to its context. False: not yet or refused; null: no console"),
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
  coverChangedBy: z
    .array(z.int())
    .nullable()
    .describe(
      "Intents that added protection on this ladder after the plan was made, so the rest of the plan was not sent. Plan again",
    ),
});
type Execution = z.infer<typeof ExecutionSchema>;

function executionView(
  stored: StoredPlan,
  recorded: boolean | null,
  coverChangedBy: number[] | null = null,
): Execution {
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
    coverChangedBy,
  };
}

/**
 * Intents on the plan's ladder that hold protection the plan did not count when it was made: neither in
 * its basis nor one of its own orders. Empty when the plan is still exactly the missing part.
 */
async function newerPositions(
  policy: AgentPolicy,
  markets: Pick<MarketsClient, "productionStrikes"> | undefined,
  stored: StoredPlan,
): Promise<number[]> {
  const own = new Set(stored.outcomes.map((o) => o.intentId));
  const { positions } = await heldPositions(
    policy,
    { eventTicker: stored.plan.eventTicker, rungs: stored.strikes },
    markets,
  );
  return positions
    .map((p) => p.intentId)
    .filter((id) => !own.has(id) && !stored.basis.has(id))
    .sort((a, b) => a - b);
}

type OrderStep =
  | { kind: "proposed"; outcome: Awaited<ReturnType<typeof proposeIntent>> }
  | { kind: "cover_changed"; intentIds: number[] }
  | { kind: "unreadable"; failure: Failure };

/**
 * Receipts every order of the plan cites: the signal the plan was built with, when it was actually
 * used, plus any the agent names. The plan's own receipt is added by the server so the evidence
 * chain (paid signal, plan, intent) does not depend on the agent remembering to repeat it.
 */
function citedReceipts(signal: HedgePlan["signal"], named: readonly string[]): string[] {
  const receipts = signal?.used === true ? [signal.receiptId, ...named] : [...named];
  return [...new Set(receipts)].slice(0, 10);
}

/**
 * Submits the plan's orders from where it left off. Returns why it stopped early, if it did.
 *
 * The call's deadline (issue #105) ends a run between two orders, never inside one: an order starts
 * only while there is time for its proposal and receipt, a proposal is broadcast only with that time
 * still left (`beginCommit`), and a broadcast proposal is always followed to its receipt. So when a
 * run stops, every order is either recorded in `stored.outcomes` or was never sent, and the next call
 * goes on from the first unrecorded order, after the same cover check as always.
 */
async function runOrders(
  ctx: ToolContext,
  policy: AgentPolicy,
  stored: StoredPlan,
  input: { reason: string; signalReceiptIds: string[] },
): Promise<{
  failure: Failure | null;
  recorded: boolean | null;
  outOfTime: boolean;
  coverChangedBy: number[] | null;
}> {
  let recorded: boolean | null = null;
  // Once the console failed to take a link, later orders only queue theirs instead of waiting again.
  let consoleDown = false;
  const { plan } = stored;
  const orderNeedsMs = reserveWithin(PROPOSAL_RESERVE_MS, ctx.deadline.budgetMs);
  while (stored.stoppedAt === null && stored.outcomes.length < plan.orders.length) {
    const stopped = stoppedFailure(ctx.deadline);
    if (stopped !== undefined) return { failure: stopped, recorded, outOfTime: true, coverChangedBy: null };
    if (ctx.deadline.remainingMs() < orderNeedsMs) {
      return { failure: null, recorded, outOfTime: true, coverChangedBy: null };
    }
    const orderIndex = stored.outcomes.length;
    const order = plan.orders[orderIndex];
    if (order === undefined) break;
    const rungIndex = Math.max(
      0,
      plan.rungs.findIndex((r) => r.instrumentSymbol === order.instrumentSymbol),
    );
    // Reading the positions and adding one is a single step per ladder, so two runs at the same
    // moment, or a stale plan, can never both count the same gap and fill it twice.
    const runStep = async (): Promise<OrderStep> => {
      let newer: number[];
      try {
        newer = await newerPositions(policy, ctx.markets, stored);
      } catch (error) {
        return { kind: "unreadable", failure: describeFailure(error, ctx) };
      }
      if (newer.length > 0) return { kind: "cover_changed", intentIds: newer };
      const proposed = await proposeIntent(
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
          signalReceiptIds: citedReceipts(plan.signal, input.signalReceiptIds),
          reason: input.reason,
        },
        { linkContext: !consoleDown },
      );
      return { kind: "proposed", outcome: proposed };
    };
    let step: OrderStep;
    try {
      step = await ctx.plans.exclusive(ladderLockKey(plan.eventTicker), runStep, {
        whileWaiting: (wait) => ctx.deadline.waitFor("lock.ladder", wait),
      });
    } catch (error) {
      // Stopped while another run held the ladder: this order was never started.
      return { failure: describeFailure(error, ctx), recorded, outOfTime: true, coverChangedBy: null };
    }
    if (step.kind === "unreadable")
      return { failure: step.failure, recorded, outOfTime: false, coverChangedBy: null };
    if (step.kind === "cover_changed") {
      return { failure: null, recorded, outOfTime: false, coverChangedBy: step.intentIds };
    }
    const outcome = step.outcome;
    const base: Omit<OrderOutcome, "decision" | "intentId" | "reason" | "txHash" | "contextLinked"> = {
      orderIndex,
      rungIndex,
      instrumentSymbol: order.instrumentSymbol,
      amountCents: order.amountCents,
      limitPrice: order.limitPriceCents,
      contextHash:
        outcome.proposal.context === null ? null : (outcome.proposal.context.hash as `0x${string}`),
    };
    if (outcome.kind === "failed") {
      // Too little time was left to broadcast: nothing was sent, and the next call sends this order.
      if (outcome.failure.reason.code === NOT_STARTED) {
        return { failure: null, recorded, outOfTime: true, coverChangedBy: null };
      }
      // Nothing reached the chain, so the next call can retry this order, unless it may have.
      if (outcome.failure.reason.code === "TX_UNCONFIRMED") {
        stored.outcomes.push({
          ...base,
          decision: "error",
          intentId: null,
          reason: "TX_UNCONFIRMED",
          txHash: null,
          contextLinked: null,
        });
        stored.stoppedAt = orderIndex;
      }
      return { failure: outcome.failure, recorded, outOfTime: false, coverChangedBy: null };
    }
    recorded = outcome.result.contextHashRecorded;
    const contextLinked = outcome.proposal.context?.contextLinked ?? null;
    if (contextLinked === false && linkPending(ctx, outcome.result.intentId)) consoleDown = true;
    stored.outcomes.push({
      ...base,
      decision: outcome.result.verdict,
      intentId: outcome.result.intentId,
      reason: outcome.result.verdict === "rejected" ? outcome.result.reason : null,
      txHash: outcome.result.txHash,
      contextLinked,
    });
    if (outcome.result.verdict === "rejected") stored.stoppedAt = orderIndex;
  }
  return { failure: null, recorded, outOfTime: false, coverChangedBy: null };
}

/**
 * Retries the console links that earlier calls for this plan could not make, in order, stopping at
 * the first the console still cannot take. Orders already sent are never sent again.
 */
async function relinkOrders(ctx: ToolContext, stored: StoredPlan): Promise<void> {
  for (const outcome of stored.outcomes) {
    if (outcome.intentId === null || outcome.contextLinked !== false) continue;
    outcome.contextLinked = await relinkContext(ctx, outcome.intentId, false);
    if (outcome.contextLinked === false && linkPending(ctx, outcome.intentId)) return;
  }
}

function verdictFor(
  stored: StoredPlan,
  failure: Failure | null,
  outOfTime: boolean,
  replayed: boolean,
  coverChangedBy: number[] | null,
): Verdict {
  const outcomes = stored.outcomes;
  if (coverChangedBy !== null) {
    const sent = outcomes.length;
    return ok(
      [
        reason(
          "COVER_CHANGED",
          `Since this plan was made, intent${coverChangedBy.length === 1 ? "" : "s"} ${coverChangedBy.map((id) => `#${id.toString()}`).join(", ")} added protection on this ladder that the plan did not count, so its remaining ${(stored.plan.orders.length - sent).toString()} order${stored.plan.orders.length - sent === 1 ? " was" : "s were"} not sent. Protection never goes beyond the goal.`,
        ),
      ],
      {
        actor: "agent",
        hint: "Call plan_hedge again with the same goal: it counts every position and plans only what is still missing, often nothing. Tell the owner what this plan did send.",
      },
    );
  }
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
  if (failure?.reason.code === TIMED_OUT) {
    const total = stored.plan.orders.length;
    return unavailable(
      [
        failure.reason,
        reason(
          "IN_PROGRESS",
          `${outcomes.length.toString()} of ${total.toString()} orders are submitted; the others were not sent.`,
        ),
      ],
      {
        actor: "agent",
        hint: `Call execute_plan again with planId ${stored.plan.planId} in a minute to continue; orders already sent are never sent twice. If it times out again, tell the owner what was slow.`,
      },
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
    hint: "The executor places approved orders. Call get_activity later to report fills to the owner.",
  });
}

export const executePlan = defineTool({
  name: "execute_plan",
  title: "Execute a hedge plan",
  description:
    "Submits the orders of a plan from plan_hedge to the Policy contract, one intent per order, in order, and reports the mandate's answer for each. It stops at the first rejection and never sends the orders after it. Orders above the approval threshold wait for the owner. Calling it again with the same planId continues where it stopped or returns the recorded results; it never sends an order twice. Before each order it checks the positions on the ladder: if other orders added protection since the plan was made, it stops (COVER_CHANGED) so protection never goes beyond the goal; plan again then. Plans can be executed for 30 minutes after planning. Get the owner's agreement first.",
  inputSchema: z.object({
    planId: z.string().trim().min(1).max(128).describe("The planId plan_hedge returned"),
    reason: decisionReasonArg,
    signalReceiptIds: signalReceiptIdsArg,
  }),
  outputSchema: verdictSchema({ execution: ExecutionSchema.nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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

    const run = () =>
      ctx.plans.exclusive(stored.plan.planId, () => executeStored(ctx, policy, stored, fresh, input), {
        whileWaiting: (wait) => ctx.deadline.waitFor("lock.plan", wait),
      });
    try {
      return await run();
    } catch (error) {
      // Stopped while another call ran this plan: nothing was started.
      const failure = stoppedFailure(ctx.deadline);
      if (failure === undefined) throw error;
      const v = unavailableFor(failure);
      return { structured: { ...v, execution: executionView(stored, null) }, summary: summarizeVerdict(v) };
    }
  },
});

/** Runs, or reports, one stored plan. Called while holding the plan's lock. */
async function executeStored(
  ctx: ToolContext,
  policy: AgentPolicy,
  stored: StoredPlan,
  fresh: boolean,
  input: { reason: string; signalReceiptIds: string[] },
) {
  await relinkOrders(ctx, stored);
  const already = stored.stoppedAt !== null || stored.outcomes.length === stored.plan.orders.length;
  const run =
    already || !fresh
      ? { failure: null, recorded: null, outOfTime: false, coverChangedBy: null }
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
      : verdictFor(stored, run.failure, run.outOfTime, already, run.coverChangedBy);
  const recorded =
    run.recorded ??
    (stored.outcomes.length === 0
      ? null
      : (ctx.ledger.lookup(stored.outcomes[0]?.intentId ?? -1)?.contextHashRecorded ?? null));
  const execution = executionView(stored, recorded, run.coverChangedBy);
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
}
