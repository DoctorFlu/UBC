/**
 * Every registered tool under one deadline (issue #105): with every upstream (chain, Gemini, console,
 * signal API) hanging until its request is aborted, each tool answers within its deadline, as a
 * successful call. A tool that waited on an upstream says `unavailable` with reason `TIMED_OUT`;
 * none answers with a bare `TIMEOUT` error, and none hangs.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { createMandateServer } from "../src/app";
import type { PaymentsClient } from "../src/services";
import { tools } from "../src/tools";
import { harness, ladderSymbol } from "./fakes";
import { captureLogs, connectClient, fixedClock, TEST_BUYER_ADDRESS } from "./helpers";

const DEADLINE_MS = 300;

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** Valid arguments for every tool. */
const ARGS: Record<string, Record<string, unknown>> = {
  buy_signal: { asset: "BTC" },
  execute_plan: { planId: "plan_missing", reason: "The owner agreed." },
  get_activity: {},
  get_intent: { intentId: 0 },
  get_ladder: { asset: "BTC" },
  get_policy: {},
  get_portfolio: {},
  get_setup_state: {},
  list_markets: {},
  ping: {},
  plan_hedge: { asset: "BTC", dropPercent: 3, maxCostCents: 4_000, requestText: "Protect my BTC." },
  propose_trade: {
    market: ladderSymbol(63_000),
    outcome: "NO",
    amountCents: 1_000,
    limitPrice: 30,
    reason: "The owner asked for it.",
  },
  request_pairing: { agentName: "Grok Bot" },
  request_policy_change: { budgetCents: 20_000, reason: "More room this week." },
  simulate_trade: { market: ladderSymbol(63_000), outcome: "NO", amountCents: 1_000, limitPrice: 30 },
  whoami: {},
};

/** The abort signal among a call's arguments, positional or in an options object. */
function signalIn(args: unknown[]): AbortSignal | undefined {
  for (const arg of args) {
    if (arg instanceof AbortSignal) return arg;
    if (arg !== null && typeof arg === "object" && "signal" in arg && arg.signal instanceof AbortSignal) {
      return arg.signal;
    }
  }
  return undefined;
}

/**
 * The service with every async method replaced by one that hangs until its call's signal aborts. A
 * method called without a signal hangs for good: the test then fails, as the call would in production.
 */
function hanging<T extends object>(service: T, sync: readonly string[] = []): T {
  return new Proxy(service, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || sync.includes(String(key))) {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (...args: unknown[]) =>
        new Promise((_, reject) => {
          signalIn(args)?.addEventListener("abort", function onAbort(this: AbortSignal) {
            reject(this.reason as Error);
          });
        });
    },
  });
}

const payments: PaymentsClient = {
  payer: TEST_BUYER_ADDRESS,
  dailyBudget: 20_000n,
  maxPrice: 5_000n,
  budget: () => ({
    day: "2026-11-15",
    dailyBudget: 20_000n,
    spent: 0n,
    remaining: 20_000n,
    resetsAt: "2026-11-16T00:00:00.000Z",
  }),
  buySignal: () => Promise.reject(new Error("replaced by the hanging proxy")),
  purchasedSignal: () => undefined,
  paidSignals: () => [],
  gatewayBalance: () => Promise.resolve(0n),
};

it.each(tools.map((tool) => tool.name))(
  "%s answers within its deadline when every upstream hangs",
  async (name) => {
    const args = ARGS[name];
    if (args === undefined) throw new Error(`no test arguments for ${name}: add them to ARGS`);
    const h = harness();
    const { logger, lines } = captureLogs();
    const { policy, markets, planner, console: consoleClient, config } = h.app;
    const server = createMandateServer(
      { ...config, limits: { ...config.limits, toolDeadlineMs: DEADLINE_MS } },
      logger,
      {
        clock: fixedClock,
        services: {
          policy: policy === undefined ? undefined : hanging(policy, ["explorerTxUrl"]),
          markets: markets === undefined ? undefined : hanging(markets),
          planner,
          console: consoleClient === undefined ? undefined : hanging(consoleClient),
          payments: hanging(payments, ["budget", "purchasedSignal", "paidSignals"]),
        },
      },
    );
    const client = await connectClient(server);
    clients.push(client);

    const started = performance.now();
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: { status?: string; reasons?: { code: string }[] };
      content: { text?: string }[];
    };
    expect(performance.now() - started).toBeLessThan(DEADLINE_MS + 1_500);
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    const stopped = lines.some((line) => line.includes('"tool.deadline_exceeded"'));
    if (stopped) {
      expect(result.structuredContent?.status).toBe("unavailable");
      expect(result.structuredContent?.reasons?.map((r) => r.code)).toContain("TIMED_OUT");
    }
    expect(lines.some((line) => line.includes('"tool.abandoned"'))).toBe(false);
  },
);
