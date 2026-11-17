/**
 * Issue #88: the hourly routine bought the same hedge twice.
 *
 * These tests run the routine from `agent/grok/routine.md` the way Grok Bot runs it: one tool call
 * per fresh MCP session, over HTTP, against the real MCP server, a real Policy contract on anvil and
 * the simulated executor filling what the contract approves. The goal is the one from the issue:
 * keep 0.05 BTC protected below $63,000 for the nearest expiry, at most $45 per plan.
 *
 * Running the routine again, at the same moment, or executing a plan made before other orders landed
 * must leave the same protection as running it once.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Intent } from "@mandate/shared";
import { ladderSymbol } from "./fakes";
import { field, startStack, type Stack, type ToolResult } from "./stack";

const GOAL = {
  asset: "BTC",
  floorCents: 6_300_000,
  maxCostCents: 4_500,
  requestText:
    "Standing goal: keep my BTC holding protected below $63,000 for the nearest expiry, spending at most $45 per plan.",
};
const REASON = "Scheduled run: the owner approved this standing goal in advance.";
/** Spot between strikes, so the top rung is a partial slice as on the hosted stack. */
const SPOT = 6_414_000;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

interface RunRecord {
  plan: ToolResult;
  executions: ToolResult[];
}

/**
 * One run of the routine. Steps 1 to 4 read; step 5 plans and executes when the plan has orders.
 * `buy_signal` is not configured here, so the run plans without a signal, as the routine allows.
 * `executeTimes` sends `execute_plan` that many times at once, like a retry that overlaps the call.
 */
async function routineRun(s: Stack, executeTimes = 1): Promise<RunRecord> {
  const setup = await s.call("get_setup_state");
  expect(field(setup.structured, "ready")).toBe(true);
  await s.call("get_policy");
  await s.call("get_activity");
  await s.call("get_portfolio");
  await s.call("get_ladder", { asset: "BTC" });
  const signal = await s.call("buy_signal", { asset: "BTC" });
  expect(field(signal.structured, "status")).not.toBe("approved");
  const plan = await s.call("plan_hedge", GOAL);
  expect(plan.isError).toBe(false);
  const planId = field(plan.structured, "plan", "planId");
  const orders = (field(plan.structured, "plan", "orders") ?? []) as unknown[];
  if (typeof planId !== "string" || orders.length === 0) return { plan, executions: [] };
  const executions = await Promise.all(
    Array.from({ length: executeTimes }, () => s.call("execute_plan", { planId, reason: REASON })),
  );
  return { plan, executions };
}

/** Contracts' worth of protection the chain records, as NO buys per market that still count. */
function bought(intents: readonly Intent[]): Record<string, { orders: number; amountCents: number }> {
  const totals: Record<string, { orders: number; amountCents: number }> = {};
  for (const intent of intents) {
    if (intent.outcome !== "NO" || !intent.isBuy) continue;
    if (intent.status === "rejected" || intent.status === "failed") continue;
    const entry = (totals[intent.market] ??= { orders: 0, amountCents: 0 });
    entry.orders += 1;
    entry.amountCents += intent.amountCents ?? 0;
  }
  return totals;
}

describe("the hedge routine against the real server, chain and executor (issue #88)", () => {
  it("buys once when it runs twice: the second run finds the goal covered", async () => {
    stack = await startStack({ holdings: [{ asset: "BTC", quantity: "0.05" }], spotCents: SPOT });
    const s = stack;

    const first = await routineRun(s);
    expect(field(first.plan.structured, "plan", "totals", "orderCount")).toBe(3);
    await s.settled();
    const once = bought(await s.intents());
    expect(Object.keys(once).sort()).toEqual(
      [ladderSymbol(64_000), ladderSymbol(63_500), ladderSymbol(63_000)].sort(),
    );

    // An hour later spot is $10 higher, so the fills cover about 99% of the loss down to the floor.
    s.markets.spotCents += 1_000;
    const second = await routineRun(s);
    await s.settled();
    expect(bought(await s.intents())).toEqual(once);
    expect(second.executions).toEqual([]);
  });

  it("buys once when two runs overlap and each retries execute_plan", async () => {
    stack = await startStack({ holdings: [{ asset: "BTC", quantity: "0.05" }], spotCents: SPOT });
    const s = stack;
    // Each ladder read sees spot $1 higher, so the two runs plan slightly different ladders.
    s.markets.driftCents = 100;

    const [a, b] = await Promise.all([routineRun(s, 2), routineRun(s, 2)]);
    expect(field(a.plan.structured, "plan", "planId")).not.toBe(field(b.plan.structured, "plan", "planId"));
    await s.settled();
    const after = bought(await s.intents());
    expect(Object.values(after).map((entry) => entry.orders)).toEqual([1, 1, 1]);

    s.markets.driftCents = 0;
    await routineRun(s);
    await s.settled();
    expect(bought(await s.intents())).toEqual(after);
  });

  it("never executes a stored plan made before other orders landed", async () => {
    stack = await startStack({ holdings: [{ asset: "BTC", quantity: "0.05" }], spotCents: SPOT });
    const s = stack;

    // Run 3 in the issue: a plan is made and left unexecuted.
    const stale = await s.call("plan_hedge", GOAL);
    const staleId = field(stale.structured, "plan", "planId");
    expect(typeof staleId).toBe("string");

    // The next run, at a slightly different price, plans and executes its own ladder.
    s.markets.spotCents += 500;
    await routineRun(s);
    await s.settled();
    const covered = bought(await s.intents());

    // Executing the stale plan now must not add protection.
    const late = await s.call("execute_plan", { planId: staleId, reason: REASON });
    expect(late.isError).toBe(false);
    await s.settled();
    expect(bought(await s.intents())).toEqual(covered);
  });

  it("counts an order waiting for the owner as cover, and buys only the missing rung once it is rejected", async () => {
    stack = await startStack({ holdings: [{ asset: "BTC", quantity: "0.12" }], spotCents: SPOT });
    const s = stack;

    // 0.12 BTC: the $63,500 rung costs $24, above the $20 approval threshold, so it waits for the owner.
    await routineRun(s);
    await s.settled();
    const intents = await s.intents();
    const held = intents.filter((intent) => intent.status === "needs_approval");
    expect(held.map((intent) => intent.market)).toEqual([ladderSymbol(63_500)]);
    const first = bought(intents);

    await routineRun(s);
    await s.settled();
    expect(bought(await s.intents())).toEqual(first);

    // The owner rejects it: that slice is now missing, and only that slice is bought again.
    const heldId = held[0]?.id ?? -1;
    await s.owner.rejectIntent(heldId);
    const third = await routineRun(s);
    const orders = (field(third.plan.structured, "plan", "orders") ?? []) as { instrumentSymbol: string }[];
    expect(orders.map((order) => order.instrumentSymbol)).toEqual([ladderSymbol(63_500)]);
    await s.settled();
    const after = bought(await s.intents());
    expect(after).toEqual(first);
  });
});
