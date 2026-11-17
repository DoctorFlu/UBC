/**
 * Issue #105 end to end: one deadline per tool call, the way Grok Bot meets it. A real MCP server over
 * HTTP, a real chain, a console over HTTP and, for market data, the real Gemini client against a fake
 * Gemini on a local port that can leave any endpoint unanswered.
 *
 * - A stalled upstream ends the call at its deadline with an `unavailable` answer naming what was slow;
 *   the stalled request is aborted, nothing is sent after the answer, and one log line says which step.
 * - `execute_plan` stopped between two orders leaves a state the next call handles: it goes on from
 *   the first unsent order, or stops with COVER_CHANGED when another proposal filled part of the gap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Category, categoryMask, type PolicyRules } from "@mandate/shared";
import { createGeminiMarkets } from "../src/markets/gemini";
import { FAKE_GEMINI_TICKER, startFakeGemini, type FakeGemini } from "./fake-gemini";
import { captureLogs } from "./helpers";
import { field, startStack, type Stack, type ToolResult } from "./stack";

let stack: Stack | undefined;
let gemini: FakeGemini | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
  await gemini?.close();
  gemini = undefined;
});

const DEADLINE_MS = 3_000;

const reasonCodes = (result: ToolResult): unknown[] =>
  ((field(result.structured, "reasons") as { code: string }[] | undefined) ?? []).map((r) => r.code);

const reasonMessage = (result: ToolResult, code: string): string =>
  ((field(result.structured, "reasons") as { code: string; message: string }[] | undefined) ?? []).find(
    (r) => r.code === code,
  )?.message ?? "";

const parsed = (lines: string[], event: string) =>
  lines
    .filter((line) => line.includes(`"${event}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("plan_hedge with a Gemini endpoint that never answers", () => {
  for (const [label, prefix, step] of [
    ["one order book", `/v1/book/GEMI-${FAKE_GEMINI_TICKER}-HI63000`, "gemini.ladder"],
    ["the spot ticker", "/v1/pubticker/", "gemini."],
  ] as const) {
    it(`answers unavailable at the deadline when ${label} stalls`, { timeout: 60_000 }, async () => {
      gemini = await startFakeGemini();
      const { logger, lines } = captureLogs();
      stack = await startStack({
        holdings: [{ asset: "BTC", quantity: "0.04213" }],
        spotCents: 6_414_000,
        marketsClient: createGeminiMarkets({ baseUrl: gemini.url }),
        env: { MCP_TOOL_DEADLINE_MS: String(DEADLINE_MS) },
        logger,
      });
      gemini.stalled.add(prefix);
      const requestText = "Protect my 0.04213 BTC against a 3% drop this week, for at most $40.";

      const started = performance.now();
      const result = await stack.call("plan_hedge", {
        asset: "BTC",
        eventTicker: FAKE_GEMINI_TICKER,
        dropPercent: 3,
        maxCostCents: 4_000,
        requestText,
      });
      const answeredAt = performance.now();

      // Answered at the deadline, well inside the 60 s an MCP client waits.
      expect(answeredAt - started).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
      expect(answeredAt - started).toBeLessThan(DEADLINE_MS + 2_000);
      expect(result.isError).toBe(false);
      expect(field(result.structured, "status")).toBe("unavailable");
      expect(reasonCodes(result)).toEqual(["TIMED_OUT"]);
      expect(reasonMessage(result, "TIMED_OUT")).toMatch(
        /^Gemini's public market data did not answer within this call's 3 s limit \(.+\)\.$/,
      );
      expect(String(field(result.structured, "nextAction", "hint"))).toMatch(/^Try this call once more/);

      // The stalled request was aborted, and nothing was sent to Gemini after the answer.
      await vi.waitFor(() => {
        expect(gemini?.openStalls()).toBe(0);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(gemini.requests.filter((r) => r.at > answeredAt)).toEqual([]);

      // One line says which step was slow, without the arguments.
      const stops = parsed(lines, "tool.deadline_exceeded");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ tool: "plan_hedge", deadlineMs: DEADLINE_MS });
      expect(String(stops[0]?.["step"])).toMatch(new RegExp(`^${step.replace(".", "\\.")}`));
      const logged = lines.join("\n");
      expect(logged).not.toContain(requestText);
      // Five decimals: a timestamp ("40.059Z") or a duration never contains it.
      expect(logged).not.toContain("0.04213");
      expect(parsed(lines, "tool.client_gone")).toEqual([]);
    });
  }
});

describe("execute_plan stopped by its deadline between two orders", () => {
  const RULES: PolicyRules = {
    budgetCents: 100_000,
    // Small trades, so the plan has several orders.
    maxTradeCents: 2_500,
    allowedCategories: categoryMask([Category.Crypto]),
    approvalAboveCents: 5_000,
    dailyLossCents: 40_000,
    paused: false,
  };
  const GOAL = {
    asset: "BTC",
    floorCents: 6_100_000,
    maxCostCents: 20_000,
    requestText: "Protect my 0.5 BTC down to $61,000 this week.",
  };
  const EXECUTE_DEADLINE_MS = 5_000;

  /**
   * A stack whose console never answers the second decision-context upload once `stall.on` is set,
   * so the second order of a run is still being sealed when the deadline passes.
   */
  async function stalledStack() {
    const stall = { on: false, seals: 0 };
    const { logger, lines } = captureLogs();
    stack = await startStack({
      holdings: [{ asset: "BTC", quantity: "0.5" }],
      spotCents: 6_414_000,
      rules: RULES,
      env: { MCP_TOOL_DEADLINE_MS: String(EXECUTE_DEADLINE_MS) },
      logger,
      consoleGate: (request) => {
        const seal = request.method === "PUT" && new URL(request.url).pathname.includes("/contexts/");
        if (!stall.on || !seal || ++stall.seals !== 2) return Promise.resolve();
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("the agent stopped waiting"));
          });
        });
      },
    });
    const plan = await stack.call("plan_hedge", GOAL);
    const planId = String(field(plan.structured, "plan", "planId"));
    const orders = field(plan.structured, "plan", "orders") as {
      instrumentSymbol: string;
      amountCents: number;
      limitPrice: number;
    }[];
    expect(orders.length).toBeGreaterThan(3);
    stall.on = true;
    return { stack, planId, orders, lines, stall };
  }

  it("sends nothing late, and the next call sends exactly the rest", { timeout: 120_000 }, async () => {
    const { stack: s, planId, orders, lines, stall } = await stalledStack();

    const started = performance.now();
    const stopped = await s.call("execute_plan", { planId, reason: "The owner agreed." });
    expect(performance.now() - started).toBeLessThan(EXECUTE_DEADLINE_MS + 2_000);
    expect(field(stopped.structured, "status")).toBe("unavailable");
    expect(reasonCodes(stopped)).toEqual(["TIMED_OUT", "IN_PROGRESS"]);
    expect(reasonMessage(stopped, "TIMED_OUT")).toMatch(
      /^The console did not answer within this call's 5 s limit/,
    );
    expect(field(stopped.structured, "execution", "submitted")).toBe(1);
    expect(parsed(lines, "tool.deadline_exceeded")[0]).toMatchObject({
      tool: "execute_plan",
      step: "console.context",
    });

    // Nothing reaches the chain after the answer.
    expect(await s.intents()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await s.intents()).toHaveLength(1);

    // The console answers again: calling again finishes the plan, each order exactly once.
    stall.on = false;
    let last: ToolResult = stopped;
    for (let call = 0; call < 6 && field(last.structured, "execution", "complete") !== true; call++) {
      last = await s.call("execute_plan", { planId, reason: "The owner agreed." });
    }
    expect(field(last.structured, "execution", "complete")).toBe(true);
    const intents = await s.intents();
    expect(intents.map((i) => [i.market, i.amountCents])).toEqual(
      orders.map((o) => [o.instrumentSymbol, o.amountCents]),
    );
  });

  it(
    "stops with COVER_CHANGED when another proposal filled part of the gap meanwhile",
    { timeout: 120_000 },
    async () => {
      const { stack: s, planId, orders, stall } = await stalledStack();

      const stopped = await s.call("execute_plan", { planId, reason: "The owner agreed." });
      expect(reasonCodes(stopped)).toEqual(["TIMED_OUT", "IN_PROGRESS"]);
      stall.on = false;

      // Before the agent calls again, one more NO contract on the same ladder is bought directly.
      const next = orders[1];
      if (next === undefined) throw new Error("the plan has a second order");
      const direct = await s.call("propose_trade", {
        market: next.instrumentSymbol,
        outcome: "NO",
        side: "buy",
        amountCents: next.amountCents,
        limitPrice: next.limitPrice,
        reason: "The owner asked for this one directly.",
      });
      expect(field(direct.structured, "status")).toBe("approved");
      const directId = field(direct.structured, "proposal", "intentId");

      const again = await s.call("execute_plan", { planId, reason: "The owner agreed." });
      expect(reasonCodes(again)).toEqual(["COVER_CHANGED"]);
      expect(field(again.structured, "execution", "coverChangedBy")).toEqual([directId]);
      expect(await s.intents()).toHaveLength(2);
    },
  );
});

describe("a proposal whose receipt the RPC endpoint holds back", () => {
  const PROPOSE_DEADLINE_MS = 5_000;
  const GOAL = {
    asset: "BTC",
    floorCents: 6_100_000,
    maxCostCents: 20_000,
    requestText: "Protect my 0.5 BTC down to $61,000 this week.",
  };

  /** A stack whose RPC endpoint holds receipt requests from the MCP server while `hold` returns a wait. */
  async function receiptStack(hold: (signal: AbortSignal) => Promise<void> | null) {
    const { logger, lines } = captureLogs();
    const s = await startStack({
      holdings: [{ asset: "BTC", quantity: "0.5" }],
      spotCents: 6_414_000,
      env: { MCP_TOOL_DEADLINE_MS: String(PROPOSE_DEADLINE_MS) },
      logger,
      rpcGate: (methods, signal) =>
        (methods.includes("eth_getTransactionReceipt") ? hold(signal) : null) ?? Promise.resolve(),
    });
    stack = s;
    const plan = await s.call("plan_hedge", GOAL);
    const planId = String(field(plan.structured, "plan", "planId"));
    const orders = field(plan.structured, "plan", "orders") as {
      instrumentSymbol: string;
      amountCents: number;
      limitPrice: number;
    }[];
    return { s, planId, orders, lines };
  }

  it(
    "is reported unconfirmed shortly after the deadline, and never sent again",
    { timeout: 120_000 },
    async () => {
      let holding = false;
      const { s, planId, lines } = await receiptStack((signal) =>
        holding
          ? new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                reject(new Error("the agent stopped waiting"));
              });
            })
          : null,
      );
      holding = true;

      const started = performance.now();
      const result = await s.call("execute_plan", { planId, reason: "The owner agreed." });
      const took = performance.now() - started;
      // The broadcast proposal is followed past the deadline, but only for COMMIT_GRACE_MS (3 s).
      expect(took).toBeGreaterThan(PROPOSE_DEADLINE_MS);
      expect(took).toBeLessThan(PROPOSE_DEADLINE_MS + 3_000 + 2_000);
      expect(field(result.structured, "status")).toBe("unavailable");
      expect(reasonCodes(result)).toEqual(["TX_UNCONFIRMED"]);
      expect(field(result.structured, "execution", "stoppedAtOrder")).toBe(0);
      expect(parsed(lines, "tool.deadline_exceeded")[0]).toMatchObject({
        tool: "execute_plan",
        step: "chain.propose",
      });
      // It did land: the chain mined it, the agent just could not see the receipt.
      expect(await s.intents()).toHaveLength(1);

      // The endpoint recovers: the next call reports the same order and sends nothing new.
      holding = false;
      const again = await s.call("execute_plan", { planId, reason: "The owner agreed." });
      expect(reasonCodes(again)).toEqual(["TX_UNCONFIRMED"]);
      expect(await s.intents()).toHaveLength(1);

      // What the answer tells the agent to do next: plan again. The order that landed late counts as
      // held, so the new plan buys only what is still missing and never that order again.
      const [late] = await s.intents();
      if (late?.amountCents == null || late.limitPrice == null)
        throw new Error("the late order is on the chain");
      const replan = await s.call("plan_hedge", GOAL);
      expect(field(replan.structured, "plan", "cover", "state")).toBe("partly_met");
      // Nothing else is held, and each hundredth of a contract pays one cent below the floor.
      expect(field(replan.structured, "plan", "cover", "heldPayoutCents")).toBe(
        Math.floor((late.amountCents * 100) / late.limitPrice),
      );
      const next = String(field(replan.structured, "plan", "planId"));
      expect(next).not.toBe(planId);
      const done = await s.call("execute_plan", { planId: next, reason: "The owner agreed." });
      expect(done.isError).toBe(false);
      expect(field(done.structured, "execution", "submitted")).toBeGreaterThan(0);
    },
  );

  it(
    "is followed to its receipt when the receipt comes just after the deadline",
    { timeout: 120_000 },
    async () => {
      let releaseAt = Number.POSITIVE_INFINITY;
      const { s, orders, lines } = await receiptStack(() => {
        const wait = releaseAt - performance.now();
        return wait > 0
          ? new Promise((resolve) => {
              setTimeout(resolve, wait);
            })
          : null;
      });
      const order = orders[0];
      if (order === undefined) throw new Error("the plan has an order");

      const started = performance.now();
      releaseAt = started + PROPOSE_DEADLINE_MS + 1_000;
      const result = await s.call("propose_trade", {
        market: order.instrumentSymbol,
        outcome: "NO",
        side: "buy",
        amountCents: order.amountCents,
        limitPrice: order.limitPrice,
        reason: "The owner asked for this one directly.",
      });
      expect(performance.now() - started).toBeGreaterThan(PROPOSE_DEADLINE_MS + 1_000);
      expect(result.isError).toBe(false);
      // The contract's real answer (the demo rules hold an order this size for the owner).
      expect(field(result.structured, "status")).toBe("held");
      expect(field(result.structured, "proposal", "decision")).toBe("needs_approval");
      expect(field(result.structured, "proposal", "intentId")).toBe(0);
      expect(parsed(lines, "tool.deadline_exceeded")[0]).toMatchObject({
        tool: "propose_trade",
        step: "chain.propose",
      });
      expect(await s.intents()).toHaveLength(1);
    },
  );
});
