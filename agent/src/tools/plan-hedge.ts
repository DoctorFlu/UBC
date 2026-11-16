import * as z from "zod";
import { LADDER_KINDS, type Ladder } from "@mandate/gemini";
import type { HedgePlan, ProtectionGoal } from "@mandate/planner";
import {
  Category,
  evaluateIntent,
  holdingQuantitySchema,
  isCategoryAllowed,
  type PolicySnapshot,
} from "@mandate/shared";
import { ToolError } from "../mcp/errors";
import { ok, reason, summarizeVerdict, verdictSchema, type Reason } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { PLAN_EXECUTABLE_FOR_MS } from "../state/plans";
import { describeFailure, notConfigured, unavailableFor, type Failure } from "../support/failures";
import { capList } from "../support/format";
import { reasonCode } from "../support/rules";
import { ladderSummaryFromLadder } from "../trading/context";
import { assetArg } from "./get-ladder";

const MAX_ORDERS_SHOWN = 20;
const MAX_PAYOFF_POINTS = 8;
const MAX_WARNINGS = 5;

const PlannedOrderSchema = z.object({
  orderIndex: z.int(),
  rungIndex: z.int(),
  instrumentSymbol: z.string(),
  strikeCents: z.int(),
  outcome: z.literal("NO"),
  quantity: z.string().describe("Contracts, two decimals"),
  contracts: z.int().describe("Whole contracts; amountCents is contracts x limitPrice"),
  limitPrice: z.int().describe("Cents per contract"),
  amountCents: z.int().describe("Most this order can cost"),
  expected: z
    .enum(["approved", "needs_approval", "rejected"])
    .describe("What the mandate would say now, counting the orders before it"),
  expectedCode: z.string().nullable(),
});

const PlanViewSchema = z.object({
  planId: z.string().describe("Pass to execute_plan"),
  status: z.enum(["ok", "partial", "empty"]),
  asset: z.string(),
  eventTicker: z.string(),
  expiry: z.string(),
  spotCents: z.int(),
  holdingQuantity: z.string(),
  ceilingCents: z.int().nullable().describe("Where protection starts"),
  floorCents: z.int().nullable().describe("Where protection stops"),
  totals: z.object({
    costCents: z.int(),
    maxPayoutCents: z.int(),
    orderCount: z.int(),
    lossAtFloorCents: z.int().nullable(),
    payoutBelowFloorCents: z.int(),
    coverageAtFloorBps: z.int().nullable().describe("10000 = the loss at the floor is fully covered"),
  }),
  orders: z.array(PlannedOrderSchema),
  ordersTruncated: z.boolean(),
  payoff: z.array(
    z.object({
      priceCents: z.int(),
      unhedgedPnlCents: z.int(),
      hedgePnlCents: z.int(),
      netPnlCents: z.int(),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  signal: z
    .object({
      receiptId: z.string(),
      used: z.boolean().describe("False when the signal does not describe this ladder and was ignored"),
      ignoredBecause: z.string().nullable(),
      changedOrders: z.boolean().describe("True when the signal changed which rungs are bought"),
    })
    .nullable()
    .describe("How a paid signal shaped this plan, or null when none was given"),
  savedToConsole: z.boolean(),
  executableUntil: z.string().describe("After this, plan again: prices move"),
});

/** What the mandate would answer for each order in turn, counting the buys approved before it. */
export function expectedVerdicts(
  plan: HedgePlan,
  snapshot: PolicySnapshot,
): { expected: "approved" | "needs_approval" | "rejected"; code: string | null }[] {
  let committedCents = snapshot.committedCents;
  return plan.orders.map((order) => {
    const evaluation = evaluateIntent(
      snapshot.rules,
      { committedCents, lossTodayCents: snapshot.lossTodayCents },
      { category: Category.Crypto, isBuy: true, amountCents: order.amountCents },
    );
    if (evaluation.verdict === "approved") committedCents += order.amountCents;
    return {
      expected: evaluation.verdict,
      code:
        evaluation.verdict === "rejected"
          ? reasonCode(evaluation.reason)
          : evaluation.verdict === "needs_approval"
            ? "OWNER_APPROVAL_REQUIRED"
            : null,
    };
  });
}

/** Up to `max` points spread evenly over the payoff table, always keeping both ends. */
export function samplePayoff<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    const point = points[Math.round((i * (points.length - 1)) / (max - 1))];
    if (point !== undefined) picked.push(point);
  }
  return picked;
}

export const planHedge = defineTool({
  name: "plan_hedge",
  title: "Plan a hedge",
  description:
    "Plans protection for a crypto holding: a staircase of NO contracts on a Gemini strike ladder that pays out as the price falls from a ceiling (default: spot) to a floor, sized to the holding and kept within the mandate's max trade size, remaining budget and the owner's cost cap. Returns the orders, cost, payoff table, what the mandate would say to each order, and a planId for execute_plan. Nothing is traded. Give exactly one of floorCents or dropPercent.",
  inputSchema: z.object({
    asset: assetArg,
    quantity: holdingQuantitySchema
      .optional()
      .describe("Units to protect, e.g. '0.05'. Default: the owner's holding of this asset in the console"),
    floorCents: z.int().min(1).optional().describe("Protect down to this price, in cents"),
    dropPercent: z.number().gt(0).lt(100).optional().describe("Or protect down to spot minus this percent"),
    ceilingCents: z.int().min(1).optional().describe("Where protection starts; default spot"),
    maxCostCents: z.int().min(1).describe("The most the owner wants to spend on this hedge, in cents"),
    horizon: z.enum(LADDER_KINDS).default("weekly").describe("Ladder expiry horizon"),
    eventTicker: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,80}$/)
      .optional()
      .describe("A specific ladder, overriding horizon"),
    slippageCents: z.int().min(0).max(10).default(0).describe("Cents added to each NO price for the limit"),
    signalReceiptId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "receiptId from buy_signal for this same ladder. The plan then buys cheap rungs first and flags expensive ones, and every order cites the receipt",
      ),
    requestText: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("The owner's request in their own words; it is sealed into each intent's decision context"),
  }),
  outputSchema: verdictSchema({ plan: PlanViewSchema.nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const none = (failure: Failure) => {
      const v = unavailableFor(failure);
      return { structured: { ...v, plan: null }, summary: summarizeVerdict(v) };
    };
    if ((input.floorCents === undefined) === (input.dropPercent === undefined)) {
      throw new ToolError("INVALID_INPUT", "Give exactly one of floorCents or dropPercent.");
    }
    if (ctx.policy === undefined) return none(notConfigured.policy());
    if (ctx.markets === undefined || ctx.planner === undefined) return none(notConfigured.markets());
    const asset = input.asset.toUpperCase();

    let quantity = input.quantity;
    if (quantity === undefined) {
      if (ctx.console === undefined) {
        return none({
          reason: reason("NO_HOLDING", "No quantity was given and the server is not linked to the console."),
          nextAction: { actor: "agent", hint: "Ask the owner how much they hold and pass it as quantity." },
        });
      }
      try {
        const { holdings } = await ctx.console.getHoldings(ctx.signal);
        quantity = holdings.find((h) => h.asset === asset)?.quantity;
      } catch (error) {
        return none(describeFailure(error, ctx));
      }
      if (quantity === undefined) {
        return none({
          reason: reason("NO_HOLDING", `The owner has no ${asset} holding in the console.`),
          nextAction: {
            actor: "owner",
            hint: `Enter the ${asset} holding in the console, or tell the agent the quantity to protect.`,
          },
        });
      }
    }

    let snapshot: PolicySnapshot;
    let ladder: Ladder;
    try {
      [snapshot, ladder] = await Promise.all([
        ctx.policy.snapshot(),
        ctx.markets.getLadder({
          asset,
          ...(input.eventTicker === undefined
            ? { horizon: input.horizon }
            : { eventTicker: input.eventTicker }),
          depth: "below-spot",
        }),
      ]);
    } catch (error) {
      return none(describeFailure(error, ctx));
    }

    const goal: ProtectionGoal = {
      ...(input.floorCents === undefined
        ? { dropPercent: input.dropPercent ?? 0 }
        : { floorCents: input.floorCents }),
      ...(input.ceilingCents === undefined ? {} : { ceilingCents: input.ceilingCents }),
    };
    // A receipt id that cannot be found is refused rather than quietly planned without the signal:
    // the owner would otherwise believe a paid signal shaped a plan that never saw it.
    const purchased =
      input.signalReceiptId === undefined ? undefined : ctx.payments?.purchasedSignal(input.signalReceiptId);
    if (input.signalReceiptId !== undefined && purchased === undefined) {
      throw new ToolError(
        "INVALID_INPUT",
        "No purchased signal has this receiptId. Use the receiptId exactly as buy_signal returned it, or leave signalReceiptId out to plan without a signal.",
      );
    }
    let plan: HedgePlan;
    try {
      plan = ctx.planner.plan({
        holding: { asset, quantity },
        ladder,
        goal,
        maxCostCents: input.maxCostCents,
        limits: {
          maxTradeCents: snapshot.rules.maxTradeCents,
          remainingBudgetCents: Math.max(0, snapshot.rules.budgetCents - snapshot.committedCents),
          categoryAllowed: isCategoryAllowed(snapshot.rules.allowedCategories, Category.Crypto),
        },
        slippageCents: input.slippageCents,
        ...(purchased === undefined ? {} : { signal: purchased }),
      });
    } catch (error) {
      return none(describeFailure(error, ctx));
    }

    const now = ctx.clock.now();
    const stored = ctx.plans.put(
      {
        plan,
        requestText: input.requestText,
        createdAt: now,
        ladderSummary: ladderSummaryFromLadder(ladder),
        categoryId: Category.Crypto,
        consoleStored: false,
      },
      now,
    );
    if (!stored.consoleStored && ctx.console !== undefined && plan.orders.length > 0) {
      try {
        await ctx.console.postPlan(
          {
            planId: plan.planId,
            asset,
            requestText: input.requestText,
            createdAt: stored.createdAt.toISOString(),
            plan: JSON.parse(JSON.stringify(plan)) as Record<string, unknown>,
          },
          ctx.signal,
        );
        stored.consoleStored = true;
      } catch (error) {
        describeFailure(error, ctx);
      }
    }

    const expected = expectedVerdicts(plan, snapshot);
    const rungIndexOf = (symbol: string) => plan.rungs.findIndex((r) => r.instrumentSymbol === symbol);
    const { items: shownOrders, truncated } = capList(plan.orders, MAX_ORDERS_SHOWN);
    const orders = shownOrders.map((order, index) => ({
      orderIndex: index,
      rungIndex: rungIndexOf(order.instrumentSymbol),
      instrumentSymbol: order.instrumentSymbol,
      strikeCents: order.strikeCents,
      outcome: "NO" as const,
      quantity: order.quantity,
      contracts: order.contracts,
      limitPrice: order.limitPriceCents,
      amountCents: order.amountCents,
      expected: expected[index]?.expected ?? "approved",
      expectedCode: expected[index]?.code ?? null,
    }));

    const holds = expected.filter((e) => e.expected === "needs_approval").length;
    const firstRejected = expected.findIndex((e) => e.expected === "rejected");
    const reasons: Reason[] = [];
    if (holds > 0) {
      reasons.push(
        reason(
          "OWNER_APPROVAL_REQUIRED",
          `${holds} of ${plan.orders.length} orders are above the owner's approval threshold and will wait for the owner.`,
        ),
      );
    }
    if (firstRejected >= 0) {
      reasons.push(
        reason(
          expected[firstRejected]?.code ?? "REJECTED",
          `Order ${firstRejected} would be rejected by the mandate as things stand, and execution stops at a rejection.`,
        ),
      );
    }
    if (!stored.consoleStored && ctx.console !== undefined && plan.orders.length > 0) {
      reasons.push(
        reason(
          "CONSOLE_NOT_SAVED",
          "The console did not accept the plan; it is kept on the server for execution.",
        ),
      );
    }
    const v =
      plan.orders.length === 0
        ? ok([...reasons, ...plan.warnings.slice(0, 2).map((w) => reason(w.code.toUpperCase(), w.message))], {
            actor: "agent",
            hint: "Tell the owner why nothing can be planned, and ask whether to change the floor, cost cap or horizon.",
          })
        : ok(reasons, {
            actor: "owner",
            hint: `Show the owner the cost and protection. If they agree, call execute_plan with planId ${plan.planId} and their reason.`,
          });

    const summary = `${ctx.planner.summarize(plan)}${plan.orders.length > 0 ? ` Plan ${plan.planId}, ${plan.orders.length} orders${holds > 0 ? `, ${holds} need the owner's approval` : ""}.` : ""}`;
    return {
      structured: {
        ...v,
        plan: {
          planId: plan.planId,
          status: plan.status,
          asset: plan.asset,
          eventTicker: plan.eventTicker,
          expiry: plan.expiry,
          spotCents: plan.spotCents,
          holdingQuantity: plan.holdingQuantity,
          ceilingCents: plan.ceilingCents,
          floorCents: plan.floorCents,
          totals: {
            costCents: plan.totals.costCents,
            maxPayoutCents: plan.totals.maxPayoutCents,
            orderCount: plan.totals.orderCount,
            lossAtFloorCents: plan.totals.lossAtFloorCents,
            payoutBelowFloorCents: plan.totals.payoutBelowFloorCents,
            coverageAtFloorBps: plan.totals.coverageAtFloorBps,
          },
          orders,
          ordersTruncated: truncated,
          payoff: samplePayoff(plan.payoff, MAX_PAYOFF_POINTS),
          warnings: plan.warnings.slice(0, MAX_WARNINGS).map((w) => ({ code: w.code, message: w.message })),
          signal:
            plan.signal === undefined
              ? null
              : {
                  receiptId: plan.signal.receiptId,
                  used: plan.signal.used,
                  ignoredBecause: plan.signal.ignoredBecause,
                  changedOrders: plan.signal.changedOrders,
                },
          savedToConsole: stored.consoleStored,
          executableUntil: new Date(stored.createdAt.getTime() + PLAN_EXECUTABLE_FOR_MS).toISOString(),
        },
      },
      summary,
    };
  },
});
