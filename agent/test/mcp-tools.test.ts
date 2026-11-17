/**
 * Every tool through the official MCP client, the way Grok Bot calls them: a fresh connection per
 * call, nothing carried between sessions but the server process. The client validates each
 * `structuredContent` against the tool's advertised output schema, so this also proves the wire shapes.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { createMandateServer, type MandateServer } from "../src/app";
import { captureLogs, connectClient, fixedClock, testResolver } from "./helpers";
import { harness, ladderSymbol } from "./fakes";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function server(): { server: MandateServer; lines: string[]; h: ReturnType<typeof harness> } {
  const h = harness();
  const { logger, lines } = captureLogs();
  const { policy, markets, planner, console: consoleClient } = h.app;
  const built = createMandateServer(h.ctx.config, logger, {
    clock: fixedClock,
    resolver: testResolver(),
    services: { policy, markets, planner, console: consoleClient },
  });
  return { server: built, lines, h };
}

/** One tool call in its own MCP session, as Grok Bot does it. */
async function call(target: MandateServer, name: string, args: Record<string, unknown> = {}) {
  const client = await connectClient(target);
  clients.push(client);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text?: string }[];
  };
}

describe("tools over MCP, one session per call", () => {
  it("runs the whole flow from setup to execution across fresh sessions", async () => {
    const { server: target, lines, h } = server();
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await call(target, name, args);
      expect(result.isError, `${name}: ${result.content[0]?.text ?? ""}`).not.toBe(true);
      return result.structuredContent ?? {};
    };

    expect(await run("get_setup_state")).toMatchObject({ ready: false });
    expect(await run("request_pairing")).toMatchObject({ status: "held" });
    h.console.confirmPairing();
    expect(await run("get_setup_state")).toMatchObject({ ready: true });
    expect(await run("get_policy")).toMatchObject({ status: "ok" });
    expect(await run("get_portfolio")).toMatchObject({ status: "ok" });
    expect(await run("list_markets")).toMatchObject({ status: "ok" });
    expect(await run("get_ladder", { asset: "BTC" })).toMatchObject({ status: "ok" });
    const planned = await run("plan_hedge", {
      asset: "BTC",
      floorCents: 6_200_000,
      maxCostCents: 5_000,
      requestText: "Protect my BTC.",
    });
    const planId = (planned["plan"] as { planId: string }).planId;
    const market = ladderSymbol(63_000);
    expect(
      await run("simulate_trade", { market, outcome: "NO", amountCents: 1_000, limitPrice: 30 }),
    ).toMatchObject({
      simulation: { wouldBe: "approved" },
    });
    expect(
      await run("propose_trade", {
        market,
        outcome: "NO",
        amountCents: 3_000,
        limitPrice: 30,
        reason: "Big.",
      }),
    ).toMatchObject({
      status: "rejected",
    });
    // The plan from an earlier session executes in this one.
    expect(await run("execute_plan", { planId, reason: "Owner agreed." })).toMatchObject({
      status: "approved",
    });
    expect(await run("get_intent", { intentId: 0 })).toMatchObject({ intent: { status: "rejected" } });
    expect(await run("get_activity", { limit: 3 })).toMatchObject({ status: "ok" });
    expect(
      await run("request_policy_change", { maxTradeCents: 5_000, reason: "Bigger rungs." }),
    ).toMatchObject({
      status: "held",
    });

    // Logs carry the tool name and verdict, never argument values or secrets.
    const log = lines.join("\n");
    expect(log).toContain('"tool":"execute_plan"');
    expect(log).not.toContain("Owner agreed.");
    expect(log).not.toContain(h.ctx.config.agentPrivateKey?.reveal() ?? "unset");
  });

  it("answers a rejected trade as a successful call with a verdict, not an error", async () => {
    const { server: target } = server();
    const result = await call(target, "propose_trade", {
      market: ladderSymbol(63_000),
      outcome: "NO",
      amountCents: 3_000,
      limitPrice: 30,
      reason: "Too big on purpose.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "rejected",
      reasons: [{ code: "OVER_MAX_TRADE_SIZE" }],
    });
    expect(result.content[0]?.text).toContain("over max trade size");
  });

  it("refuses a request to unpause with INVALID_INPUT naming the field", async () => {
    const { server: target } = server();
    const result = await call(target, "request_policy_change", { paused: false, reason: "Resume trading." });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^INVALID_INPUT: .*paused/);
  });

  it("keeps every result small", async () => {
    const { server: target } = server();
    for (const [name, args] of [
      ["get_ladder", { asset: "BTC" }],
      ["plan_hedge", { asset: "BTC", floorCents: 6_100_000, maxCostCents: 20_000, requestText: "r" }],
      ["list_markets", {}],
    ] as const) {
      const result = await call(target, name, args);
      expect(JSON.stringify(result).length, name).toBeLessThan(12_000);
    }
  });
});
