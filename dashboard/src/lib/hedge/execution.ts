/**
 * Which of a plan's orders reached the chain. The only link the console trusts between an intent and a
 * plan is the agent's sealed reason: a decision context whose hash checks out (`verified`) and that
 * names the plan. An order is matched to such an intent by market and amount, each intent once.
 */
import type { IntentStatus, IntentView } from "@mandate/shared";
import type { HedgePlan, PlannedOrder } from "@mandate/planner";

import type { ChainView } from "@/lib/live/types";

export interface OrderOnChain {
  order: PlannedOrder;
  index: number;
  /** The intent that proposed this order, or null when none cites the plan for it. */
  intent: IntentView | null;
}

export interface PlanExecution {
  orders: OrderOnChain[];
  /** Intents that cite the plan but match none of its orders (for example a re-sized retry). */
  extra: IntentView[];
  /** Orders with an intent on the chain. */
  proposed: number;
  byStatus: Partial<Record<IntentStatus, number>>;
  /** Filled cents the executor recorded across the plan's intents. */
  filledCents: number;
}

/** Intents whose verified sealed reason names `planId`. */
export function intentsCitingPlan(
  chain: Pick<ChainView, "intents" | "sealed">,
  planId: string,
): IntentView[] {
  return chain.intents.filter((intent) => {
    const sealed = chain.sealed[intent.id];
    return sealed?.status === "verified" && sealed.document.planId === planId;
  });
}

export function planExecution(
  plan: Pick<HedgePlan, "planId" | "orders">,
  chain: Pick<ChainView, "intents" | "sealed"> | null,
): PlanExecution {
  const citing = chain ? intentsCitingPlan(chain, plan.planId) : [];
  const unused = [...citing];
  const orders = plan.orders.map((order, index): OrderOnChain => {
    const at = unused.findIndex(
      (intent) => intent.market === order.instrumentSymbol && intent.amountCents === order.amountCents,
    );
    const intent = at >= 0 ? (unused.splice(at, 1)[0] ?? null) : null;
    return { order, index, intent };
  });
  const byStatus: Partial<Record<IntentStatus, number>> = {};
  let filledCents = 0;
  for (const intent of citing) {
    byStatus[intent.status] = (byStatus[intent.status] ?? 0) + 1;
    if (intent.status === "executed") filledCents += intent.filledCents ?? 0;
  }
  return {
    orders,
    extra: unused,
    proposed: orders.filter((entry) => entry.intent !== null).length,
    byStatus,
    filledCents,
  };
}

/**
 * One honest line about a plan's execution, from what the chain shows. `expired`: the plan's ladder has
 * expired, so an unexecuted plan never will be.
 */
export function executionSummary(execution: PlanExecution, orderCount: number, expired = false): string {
  if (orderCount === 0) return "Nothing to execute: the plan has no orders.";
  if (execution.proposed === 0 && execution.extra.length === 0) {
    return expired
      ? "Not executed: no intent on the chain cites this plan, and its ladder has expired."
      : "Not executed: no intent on the chain cites this plan yet.";
  }
  const parts: string[] = [`${String(execution.proposed)} of ${String(orderCount)} orders proposed`];
  const executed = execution.byStatus.executed ?? 0;
  const failed = execution.byStatus.failed ?? 0;
  const waiting = execution.byStatus.needs_approval ?? 0;
  const rejected = execution.byStatus.rejected ?? 0;
  if (executed > 0) parts.push(`${String(executed)} filled`);
  if (failed > 0) parts.push(`${String(failed)} not filled`);
  if (waiting > 0) parts.push(`${String(waiting)} waiting for you`);
  if (rejected > 0) parts.push(`${String(rejected)} rejected`);
  const extra = execution.extra.length;
  if (extra > 0) {
    parts.push(
      `and ${String(extra)} other ${extra === 1 ? "intent cites" : "intents cite"} the plan without matching an order`,
    );
  }
  return `${parts.join(", ")}.`;
}
