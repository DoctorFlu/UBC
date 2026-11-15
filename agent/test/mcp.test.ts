import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(listedPing?.outputSchema).toMatchObject({ type: "object" });
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

  it("times out slow handlers with TIMEOUT and aborts their signal", async () => {
    let aborted = false;
    const slow = defineTool({
      name: "slow",
      title: "Slow",
      description: "Test tool",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      timeoutMs: 50,
      handler: (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => {
            resolve({ structured: { ok: true }, summary: "late" });
          }, 1000);
        }),
    });
    const client = await connect(testServer({ tools: [slow] }));
    const result = await client.callTool({ name: "slow", arguments: {} });
    expect(text(result)).toMatch(/^TIMEOUT: /);
    expect(aborted).toBe(true);
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
