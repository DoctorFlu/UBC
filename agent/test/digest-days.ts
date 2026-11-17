/**
 * Days for the daily digest (issue #97, `agent/grok/digest.md`): a real Policy contract on anvil, the
 * simulated executor, the fake console measuring cover with the planner, and the real MCP server over
 * HTTP. Each day is built through the tools, as the hourly routine and the owner would build it.
 */
import type { Clock } from "../src/context";
import type { PaymentsClient } from "../src/services";
import { TEST_BUYER_ADDRESS } from "./helpers";
import { ladderSymbol } from "./fakes";
import { field, startStack, type Stack, type ToolResult } from "./stack";

export const DIGEST_CONSOLE_URL = "https://console.example";
export const GOAL = {
  asset: "BTC",
  floorCents: 6_300_000,
  maxCostCents: 4_500,
  requestText: "Standing goal: keep my BTC holding protected below $63,000 for the nearest expiry.",
};
const REASON = "Scheduled run: the owner approved this standing goal in advance.";
const SPOT = 6_414_000;
const HOUR_MS = 3_600_000;

/** A clock the test can move: the MCP server reads the day from it. */
export class MovableClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

/** A signal wallet with payments on record, `hoursAgo` before the clock's now; it never buys. */
export function paidSignals(clock: Clock, hoursAgo: readonly number[]) {
  const bought: unknown[] = [];
  const at = clock.now().getTime();
  const payments: PaymentsClient = {
    payer: TEST_BUYER_ADDRESS,
    dailyBudget: 200_000n,
    maxPrice: 50_000n,
    budget: () => ({
      day: clock.now().toISOString().slice(0, 10),
      dailyBudget: 200_000n,
      spent: 0n,
      remaining: 200_000n,
      resetsAt: `${new Date(clock.now().getTime() + 24 * HOUR_MS).toISOString().slice(0, 10)}T00:00:00.000Z`,
    }),
    buySignal: (request) => {
      bought.push(request.query);
      return Promise.reject(new Error("the digest never buys a signal"));
    },
    purchasedSignal: () => undefined,
    paidSignals: () =>
      hoursAgo.map((hours, index) => ({
        receiptId: `0x${String(index + 1).padStart(64, "0")}`,
        amount: 10_000n,
        paidAt: new Date(at - hours * HOUR_MS).toISOString(),
        url: "/v1/signal/hedge?asset=BTC",
      })),
    gatewayBalance: () => Promise.resolve(1_000_000n),
  };
  return { payments, bought };
}

export interface Day {
  stack: Stack;
  clock: MovableClock;
  /** Signal purchases asked of the wallet. */
  bought: unknown[];
}

async function protect(s: Stack): Promise<void> {
  const plan = await s.call("plan_hedge", GOAL);
  const planId = field(plan.structured, "plan", "planId");
  if (typeof planId !== "string") throw new Error(`no plan: ${plan.text}`);
  await s.call("execute_plan", { planId, reason: REASON });
  await s.settled();
}

async function settlements(s: Stack, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && s.console.state.settlements.size < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (s.console.state.settlements.size < count) throw new Error("the executor recorded no settlement");
}

/** Yesterday's run protected 0.05 BTC; nothing happened since. The digest runs 25 hours later. */
export async function quietDay(): Promise<Day> {
  const clock = new MovableClock();
  const { payments, bought } = paidSignals(clock, [1]);
  const stack = await startStack({
    holdings: [{ asset: "BTC", quantity: "0.05" }],
    spotCents: SPOT,
    payments,
    clock,
    consoleUrl: DIGEST_CONSOLE_URL,
  });
  await protect(stack);
  clock.offsetMs = 25 * HOUR_MS;
  return { stack, clock, bought };
}

/**
 * Yesterday's ladder expired and settled; the routine protected the next one. Two signals were bought
 * today, one yesterday.
 */
export async function settledDay(): Promise<Day> {
  const clock = new MovableClock();
  const { payments, bought } = paidSignals(clock, [30, 6, 1]);
  const stack = await startStack({
    holdings: [{ asset: "BTC", quantity: "0.05" }],
    spotCents: SPOT,
    payments,
    clock,
    consoleUrl: DIGEST_CONSOLE_URL,
  });
  await protect(stack);
  const filled = (await stack.intents()).filter((intent) => intent.status === "executed").length;
  stack.markets.expire(6_325_000);
  await settlements(stack, filled);
  await protect(stack);
  return { stack, clock, bought };
}

/**
 * A larger holding: one order is over the owner's $20 approval threshold and waits for the owner. A
 * call outside the routine was rejected over the max trade size, and the agent asked the owner to raise it.
 */
export async function waitingDay(): Promise<Day> {
  const clock = new MovableClock();
  const { payments, bought } = paidSignals(clock, [2]);
  const stack = await startStack({
    holdings: [{ asset: "BTC", quantity: "0.105" }],
    spotCents: SPOT,
    payments,
    clock,
    consoleUrl: DIGEST_CONSOLE_URL,
  });
  await stack.call("propose_trade", {
    market: ladderSymbol(64_000),
    outcome: "NO",
    amountCents: 3_000,
    limitPrice: 40,
    requestText: "Hedge my BTC.",
    reason: "A larger hedge.",
  });
  await protect(stack);
  await stack.call("request_policy_change", {
    approvalAboveCents: 2_500,
    reason: "The $63,500 rung needs $21, above the $20 approval threshold, so every run waits for you.",
  });
  return { stack, clock, bought };
}

/** The digest's calls, in the order `agent/grok/digest.md` makes them. */
export const DIGEST_CALLS = [
  ["get_setup_state", {}],
  ["get_policy", {}],
  ["get_portfolio", {}],
  ["get_activity", { limit: 1 }],
] as const;

export async function digest(s: Stack): Promise<Record<string, ToolResult>> {
  const results: Record<string, ToolResult> = {};
  for (const [name, args] of DIGEST_CALLS) results[name] = await s.call(name, args);
  return results;
}
