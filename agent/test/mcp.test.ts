import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { ToolError } from "../src/mcp/errors";
import { defineTool } from "../src/mcp/tool";
import { ping } from "../src/tools/ping";
import { tools } from "../src/tools";
import { SERVER_INSTRUCTIONS } from "../src/instructions";
import { SERVER_VERSION } from "../src/version";
import {
  authHeader,
  connectClient,
  initializeRequest,
  post,
  TEST_ADDRESS,
  TEST_POLICY,
  TEST_PRIVATE_KEY,
  testServer,
} from "./helpers";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(...args: Parameters<typeof connectClient>) {
  const client = await connectClient(...args);
  clients.push(client);
  return client;
}

function text(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((block) => block.text ?? "").join("\n");
}

describe.each(["legacy", "auto"] as const)("MCP round trip (%s era negotiation)", (era) => {
  it("initializes with the server instructions and lists every registered tool", async () => {
    const server = testServer();
    const client = await connect(server, { era });

    expect(client.getProtocolEra()).toBe(era === "auto" ? "modern" : "legacy");
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()).toMatchObject({ name: "mandate", version: SERVER_VERSION });

    const { tools: listed } = await client.listTools();
    expect(listed.map((tool) => tool.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
    const listedPing = listed.find((tool) => tool.name === "ping");
    expect(listedPing?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // Output schemas are left out of the list by default: they are most of its size.
    expect(listedPing?.outputSchema).toBeUndefined();
    expect(listedPing?.inputSchema).toMatchObject({ type: "object" });
  });

  it("advertises output schemas when asked to", async () => {
    const server = testServer({ env: { MCP_ADVERTISE_OUTPUT_SCHEMAS: "true" } });
    const { tools: listed } = await (await connect(server, { era })).listTools();
    for (const tool of listed) expect(tool.outputSchema).toMatchObject({ type: "object" });
  });

  it("keeps the whole tool list small enough for a chat agent to carry in every conversation", async () => {
    const { tools: listed } = await (await connect(testServer(), { era })).listTools();
    expect(JSON.stringify(listed).length).toBeLessThan(24_000);
  });

  it("calls ping and returns structured content plus a text summary", async () => {
    const client = await connect(testServer(), { era });
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: "ok",
      serverTime: "2026-11-15T12:00:00.000Z",
      version: SERVER_VERSION,
    });
    expect(text(result)).toContain("is up");
  });

  it("calls whoami without ever returning the key", async () => {
    const server = testServer({ env: { AGENT_PRIVATE_KEY: TEST_PRIVATE_KEY, POLICY_ADDRESS: TEST_POLICY } });
    const client = await connect(server, { era });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toEqual({
      agentAddress: TEST_ADDRESS,
      chain: { rpcHost: "rpc.testnet.arc.io" },
      policyAddress: TEST_POLICY,
      capabilities: { readPolicy: true, proposeTrades: true, console: false },
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(server.lines.join("\n")).not.toContain(TEST_PRIVATE_KEY.slice(2));
  });

  it("reports invalid input as a tool error with a stable code and no echoed values", async () => {
    const echo = defineTool({
      name: "echo_amount",
      title: "Echo",
      description: "Test tool",
      inputSchema: z.object({ amount: z.number().positive() }),
      outputSchema: z.object({ amount: z.number() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: ({ amount }) => ({ structured: { amount }, summary: `Got ${amount}.` }),
    });
    const client = await connect(testServer({ tools: [ping, echo] }), { era });

    const bad = await client.callTool({ name: "echo_amount", arguments: { amount: "s3cr3t-value" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^INVALID_INPUT: Invalid arguments\. amount: /);
    expect(text(bad)).not.toContain("s3cr3t-value");
    expect(bad.structuredContent).toBeUndefined();

    const good = await client.callTool({ name: "echo_amount", arguments: { amount: 5 } });
    expect(good.structuredContent).toEqual({ amount: 5 });
  });
});

describe("tool failures", () => {
  const failing = (error: unknown) =>
    defineTool({
      name: "fails",
      title: "Fails",
      description: "Test tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: () => {
        throw error;
      },
    });

  it("passes a ToolError's code and message to the model", async () => {
    const tool = failing(
      new ToolError("UPSTREAM_UNAVAILABLE", "The chain RPC is not reachable. Try again shortly."),
    );
    const client = await connect(testServer({ tools: [tool] }));
    const result = await client.callTool({ name: "fails", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("UPSTREAM_UNAVAILABLE: The chain RPC is not reachable. Try again shortly.");
  });

  it("hides unexpected errors behind INTERNAL and scrubs them in the log", async () => {
    const leaky = new Error("boom at https://rpc.example/key123abc with 0x" + "ab".repeat(32));
    const server = testServer({ tools: [failing(leaky)] });
    const client = await connect(server);
    const result = await client.callTool({ name: "fails", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /^INTERNAL: Something went wrong on the server \(request [0-9a-f-]{36}\)\.$/,
    );
    const logs = server.lines.join("\n");
    expect(logs).toContain("tool.internal_error");
    expect(logs).not.toContain("key123abc");
    expect(logs).not.toContain("ab".repeat(32));
    expect(logs).not.toContain("at Object.");
  });

  it("stops a call at its deadline: aborts its signal, names the slow step, logs one line", async () => {
    let aborted = false;
    const slow = defineTool({
      name: "slow",
      title: "Slow",
      description: "Test tool",
      inputSchema: z.object({ secret: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (_input, ctx) =>
        ctx.deadline.step("chain.snapshot", (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(signal.reason as Error);
            });
          });
        }),
    });
    const server = testServer({ tools: [slow], limits: { toolDeadlineMs: 200 } });
    const client = await connect(server);
    const started = performance.now();
    const result = await client.callTool({ name: "slow", arguments: { secret: "do-not-log-me" } });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(text(result)).toMatch(
      /^TIMEOUT: The Arc RPC endpoint did not answer within this call's 0.2 s limit/,
    );
    expect(aborted).toBe(true);
    const stops = server.lines.filter((line) => line.includes('"tool.deadline_exceeded"'));
    expect(stops).toHaveLength(1);
    const stop = JSON.parse(stops[0] ?? "{}") as Record<string, unknown>;
    expect(stop).toMatchObject({ level: "warn", tool: "slow", step: "chain.snapshot", deadlineMs: 200 });
    expect(typeof stop["stepMs"]).toBe("number");
    expect(typeof stop["durationMs"]).toBe("number");
    expect(server.lines.join("\n")).not.toContain("do-not-log-me");
  });

  it("a tool can only shorten the server's deadline", async () => {
    let budget = 0;
    const probe = defineTool({
      name: "probe",
      title: "Probe",
      description: "Test tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      timeoutMs: 90_000,
      handler: (_input, ctx) => {
        budget = ctx.deadline.budgetMs;
        return { structured: { ok: true }, summary: "ok" };
      },
    });
    const client = await connect(testServer({ tools: [probe], limits: { toolDeadlineMs: 7_000 } }));
    await client.callTool({ name: "probe", arguments: {} });
    expect(budget).toBe(7_000);
  });

  it(
    "answers TIMEOUT a grace period after the deadline when a handler ignores its signal",
    { timeout: 15_000 },
    async () => {
      const stubborn = defineTool({
        name: "stubborn",
        title: "Stubborn",
        description: "Test tool",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        timeoutMs: 50,
        handler: () =>
          new Promise<{ structured: { ok: boolean }; summary: string }>((resolve) => {
            setTimeout(() => {
              resolve({ structured: { ok: true }, summary: "late" });
            }, 10_000).unref();
          }),
      });
      const server = testServer({ tools: [stubborn] });
      const client = await connect(server);
      const result = await client.callTool({ name: "stubborn", arguments: {} });
      expect(text(result)).toMatch(
        /^TIMEOUT: The server could not finish this call within its 0.1 s limit\./,
      );
      expect(server.lines.some((line) => line.includes('"tool.abandoned"'))).toBe(true);
    },
  );

  it("logs one line naming the step when the client goes away mid-call", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = defineTool({
      name: "waiting",
      title: "Waiting",
      description: "Test tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (_input, ctx) =>
        ctx.deadline.step("console.holdings", (signal) => {
          started();
          return new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(signal.reason as Error);
            });
          });
        }),
    });
    const server = testServer({ tools: [waiting] });
    const client = new AbortController();
    const response = server.fetch(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...authHeader(),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "waiting", arguments: {} },
        }),
        signal: client.signal,
      }),
    );
    await running;
    client.abort();
    await Promise.resolve(response).catch(() => undefined);
    await vi.waitFor(() => {
      expect(server.lines.some((line) => line.includes('"tool.call"'))).toBe(true);
    });
    const gone = server.lines.filter((line) => line.includes('"tool.client_gone"'));
    expect(gone).toHaveLength(1);
    expect(JSON.parse(gone[0] ?? "{}")).toMatchObject({ tool: "waiting", step: "console.holdings" });
    expect(server.lines.some((line) => line.includes('"tool.deadline_exceeded"'))).toBe(false);
  });

  it("rejects output that does not match the output schema as INTERNAL", async () => {
    const wrong = defineTool({
      name: "wrong_output",
      title: "Wrong",
      description: "Test tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: () => ({ structured: { count: "three" as unknown as number }, summary: "three" }),
    });
    const client = await connect(testServer({ tools: [wrong] }));
    const result = await client.callTool({ name: "wrong_output", arguments: {} });
    expect(text(result)).toMatch(/^INTERNAL: /);
  });
});

describe("logging", () => {
  it("logs tool name, outcome, duration and argument shape, but not argument values", async () => {
    const server = testServer();
    const client = await connect(server);
    await client.callTool({ name: "ping", arguments: { note: "do-not-log-me" } });
    const entry = server.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line["event"] === "tool.call");
    expect(entry).toMatchObject({ tool: "ping", outcome: "ok", status: "ok", argKeys: ["note"] });
    expect(entry?.["requestId"]).toEqual(expect.any(String));
    expect(entry?.["durationMs"]).toEqual(expect.any(Number));
    expect(server.lines.join("\n")).not.toContain("do-not-log-me");
  });

  it("never logs the bearer token", async () => {
    const server = testServer();
    const client = await connect(server);
    await client.callTool({ name: "ping", arguments: {} });
    await post(server, initializeRequest, authHeader("wrong-token-wrong-token-wrong-token"));
    expect(server.lines.length).toBeGreaterThan(0);
    const logs = server.lines.join("\n");
    expect(logs).not.toContain(authHeader().authorization.slice(7));
    expect(logs).not.toContain("wrong-token");
  });
});

describe("JSON-only responses", () => {
  it("answers a 2025-era initialize with application/json, not an event stream", async () => {
    const response = await post(testServer(), initializeRequest, authHeader());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = (await response.json()) as { result: { protocolVersion: string; instructions: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});
