import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, parseTransaction, recoverTransactionAddress } from "viem";
import { policyBaseAbi } from "@mandate/shared";
import { createMandateServer, type MandateServer } from "../src/app";
import { FAILED_AUTH_LIMIT } from "../src/http/app";
import { scrubText } from "../src/logger";
import { Secret } from "../src/secret";
import { ConsoleSigner } from "../src/tenancy/console-signer";
import { ConsoleTokenResolver, createTokenResolver } from "../src/tenancy/resolver";
import { CONSOLE_TOKEN, harness } from "./fakes";
import {
  TEST_BUYER_KEY,
  TEST_POLICY,
  TEST_TOKEN,
  captureLogs,
  connectClient,
  fixedClock,
  post,
} from "./helpers";

/**
 * Agents of several workspaces through one MCP server (docs/accounts.md): the console decides which agent
 * each bearer token acts for, nothing is cached, and each agent reaches only its own mandate.
 */

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function setup() {
  const h = harness();
  const { logger, lines } = captureLogs();
  const { policy, markets, planner, console: consoleClient } = h.ctx;
  const server = createMandateServer(h.ctx.config, logger, {
    clock: fixedClock,
    resolver: createTokenResolver(h.ctx.config, h.console.clientFetch),
    services: { policy, markets, planner, console: consoleClient },
  });
  return { h, server, lines, fake: h.console };
}

async function call(server: MandateServer, token: string, name: string, args: Record<string, unknown> = {}) {
  const client = await connectClient(server, { token });
  clients.push(client);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

function resolveCount(fake: { state: { requests: string[] } }): number {
  return fake.state.requests.filter((r) => r === "POST /api/agent/v1/auth/resolve").length;
}

describe("token resolution", () => {
  function resolver(fake: ReturnType<typeof setup>["fake"], serviceToken = CONSOLE_TOKEN) {
    return new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(serviceToken),
      legacyToken: new Secret(TEST_TOKEN),
      fetch: fake.clientFetch,
    });
  }

  it("names the agent of a live token, and nothing for an unknown or revoked one", async () => {
    const { fake } = setup();
    const other = fake.addAgent();
    const r = resolver(fake);
    expect(await r.resolve(other.token)).toMatchObject({
      kind: "agent",
      agent: { agentId: other.agentId, mandateId: other.mandateId, agent: { signer: "console" } },
    });
    expect(await r.resolve(`mdt_${"x".repeat(43)}`)).toEqual({ kind: "unknown" });
    fake.revokeToken(other.token);
    expect(await r.resolve(other.token)).toEqual({ kind: "unknown" });
  });

  it("registers the env-file token once for the first mandate's agent, and a revoke is final", async () => {
    const { fake } = setup();
    const r = resolver(fake);
    expect(await r.resolve(TEST_TOKEN)).toMatchObject({ kind: "agent", agent: { agentId: "env" } });
    // Another server presenting a different env-file token cannot register a second one.
    const impostor = new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      legacyToken: new Secret("another-env-file-token-0123456789abcdef"),
      fetch: fake.clientFetch,
    });
    expect(await impostor.resolve("another-env-file-token-0123456789abcdef")).toEqual({ kind: "unknown" });
    fake.revokeToken(TEST_TOKEN);
    expect(await r.resolve(TEST_TOKEN)).toEqual({ kind: "unknown" });
  });

  it("fails closed when the console is down, refuses the service token, or cannot be reached", async () => {
    const { fake } = setup();
    fake.setDown(true);
    expect(await resolver(fake).resolve(TEST_TOKEN)).toMatchObject({ kind: "unavailable" });
    fake.setDown(false);
    expect(await resolver(fake, "wrong-service-token-0123456789").resolve(TEST_TOKEN)).toMatchObject({
      kind: "unavailable",
    });
    const unreachable = new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      legacyToken: new Secret(TEST_TOKEN),
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(await unreachable.resolve(TEST_TOKEN)).toMatchObject({ kind: "unavailable" });
  });

  it("passes on the console's limit on failed lookups", async () => {
    const limited = new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      legacyToken: new Secret(TEST_TOKEN),
      fetch: () => Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "7" } })),
    });
    expect(await limited.resolve("anything")).toEqual({ kind: "limited", retryAfter: 7 });
  });

  it("sends the console the token's hash, never the token", async () => {
    const sent: string[] = [];
    const { fake } = setup();
    const spy = new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      legacyToken: new Secret(TEST_TOKEN),
      fetch: async (input, init) => {
        sent.push(typeof init.body === "string" ? init.body : "");
        return fake.clientFetch(input, init);
      },
    });
    await spy.resolve(TEST_TOKEN);
    expect(sent.join("")).not.toContain(TEST_TOKEN);
  });
});

describe("the MCP endpoint with several workspaces", () => {
  it("acts for the agent each token names, and answers 401 for an unknown token", async () => {
    const { server, fake } = setup();
    const other = fake.addAgent();
    const mine = await call(server, TEST_TOKEN, "whoami");
    expect(mine.structuredContent?.agent).toEqual({ id: "env", mandateId: "mnd_first" });
    const theirs = await call(server, other.token, "whoami");
    expect(theirs.structuredContent?.agent).toEqual({ id: other.agentId, mandateId: other.mandateId });
    expect(theirs.structuredContent?.policyAddress).toBeNull();
    expect(theirs.structuredContent?.capabilities).toMatchObject({ proposeTrades: false, readPolicy: false });

    const unknown = await post(server, initialize, { authorization: `Bearer mdt_${"y".repeat(43)}` });
    expect(unknown.status).toBe(401);
  });

  it("stops a revoked token on its next call", async () => {
    const { server, fake } = setup();
    const other = fake.addAgent();
    expect((await post(server, initialize, { authorization: `Bearer ${other.token}` })).status).toBe(200);
    fake.revokeToken(other.token);
    expect((await post(server, initialize, { authorization: `Bearer ${other.token}` })).status).toBe(401);
  });

  it("refuses every token, the env-file one too, while the console cannot be asked", async () => {
    const { server, fake } = setup();
    fake.setDown(true);
    const response = await post(server, initialize, { authorization: `Bearer ${TEST_TOKEN}` });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("limits failed tokens per client before asking the console, and keeps good tokens working", async () => {
    const { server, fake } = setup();
    for (let attempt = 0; attempt < FAILED_AUTH_LIMIT.capacity; attempt += 1) {
      expect(
        (await post(server, initialize, { authorization: `Bearer guess-${String(attempt)}` })).status,
      ).toBe(401);
    }
    const asked = resolveCount(fake);
    const blocked = await post(server, initialize, { authorization: "Bearer one-more-guess" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(resolveCount(fake)).toBe(asked);
  });

  it("reads and writes each agent's own records in the console", async () => {
    const { server, fake } = setup();
    const other = fake.addAgent({ privateKey: TEST_BUYER_KEY });
    other.state.holdings = [{ asset: "ETH", quantity: "2" }];
    const theirs = await call(server, other.token, "get_portfolio");
    expect(JSON.stringify(theirs.structuredContent)).toContain("ETH");
    expect(JSON.stringify(theirs.structuredContent)).not.toContain("cold wallet");
    const mine = await call(server, TEST_TOKEN, "get_portfolio");
    expect(JSON.stringify(mine.structuredContent)).toContain("BTC");

    const filed = await call(server, other.token, "request_policy_change", {
      maxTradeCents: 2_000,
      reason: "Smaller rungs.",
    });
    expect(filed.isError).not.toBe(true);
    expect(other.state.changeRequests.size).toBe(1);
    expect(fake.state.changeRequests.size).toBe(0);
  });

  it("keeps plans and proposals apart, and keeps signals for the first mandate's agent", async () => {
    const { server, fake } = setup();
    const other = fake.addAgent();
    const resolved = await new ConsoleTokenResolver({
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      legacyToken: new Secret(TEST_TOKEN),
      fetch: fake.clientFetch,
    }).resolve(other.token);
    if (resolved.kind !== "agent") throw new Error("not resolved");
    const context = server.agents.contextFor(resolved.agent);
    expect(context.plans).not.toBe(server.context.plans);
    expect(context.ledger).not.toBe(server.context.ledger);
    expect(context.payments).toBeUndefined();
    expect(context.console?.agentId).toBe(other.agentId);
    // The same agent keeps its plans when the console's answer is the same, and across a rebuild.
    expect(server.agents.contextFor(resolved.agent)).toBe(context);
    const moved = server.agents.contextFor({ ...resolved.agent, workspaceId: "wsp_moved" });
    expect(moved.plans).toBe(context.plans);

    const signal = await call(server, other.token, "buy_signal", { asset: "BTC" });
    expect(JSON.stringify(signal.structuredContent)).toContain("NOT_CONFIGURED");
  });

  it("gives another agent nothing for a plan id it did not make", async () => {
    const { server, fake } = setup();
    // An agent that could execute a plan: it has a key in the console and a contract to propose to.
    const other = fake.addAgent({
      privateKey: TEST_BUYER_KEY,
      contract: { policyAddress: TEST_POLICY, chainId: 5_042_002 },
    });
    const planned = await call(server, TEST_TOKEN, "plan_hedge", {
      asset: "BTC",
      floorCents: 6_200_000,
      maxCostCents: 5_000,
      requestText: "Protect my BTC to $62k.",
    });
    const planId = (planned.structuredContent?.plan as { planId?: string } | null)?.planId;
    expect(planId).toEqual(expect.any(String));

    const stolen = await call(server, other.token, "execute_plan", {
      planId,
      reason: "Someone else's plan.",
    });
    expect(stolen.structuredContent).toMatchObject({ reasons: [{ code: "PLAN_NOT_FOUND" }] });
    expect(fake.stateOf(other.agentId).contexts.size).toBe(0);
    expect(fake.state.contexts.size).toBe(0);
  });
});

describe("the console-held signer", () => {
  it("gets a proposeTrade to the mandate's contract signed, and nothing else", async () => {
    const { fake } = setup();
    const other = fake.addAgent({
      privateKey: TEST_BUYER_KEY,
      contract: { policyAddress: TEST_POLICY, chainId: 5_042_002 },
    });
    if (other.address === null) throw new Error("no address");
    const signer = new ConsoleSigner({
      address: other.address,
      agentId: other.agentId,
      baseUrl: "http://console.test",
      serviceToken: new Secret(CONSOLE_TOKEN),
      fetch: fake.clientFetch,
    });
    const base = {
      type: "eip1559" as const,
      chainId: 5_042_002,
      nonce: 0,
      gas: 300_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      value: 0n,
    };
    // Not a Policy call: refused before the key is used.
    await expect(signer.signTransaction({ ...base, to: TEST_POLICY, data: "0xdeadbeef" })).rejects.toThrow(
      /refused to sign/,
    );
    const data = encodeFunctionData({
      abi: policyBaseAbi,
      functionName: "proposeTrade",
      args: ["GEMI-BTC2611202200-HI64000", 1, "NO", true, 1_000n, 40n],
    });
    // A proposal to another address, or on another chain: refused.
    await expect(signer.signTransaction({ ...base, to: other.address, data })).rejects.toThrow(
      /refused to sign/,
    );
    await expect(signer.signTransaction({ ...base, chainId: 1, to: TEST_POLICY, data })).rejects.toThrow(
      /refused to sign/,
    );
    // A proposal to its own contract: signed with the agent's key, which the MCP server never saw.
    const signed = await signer.signTransaction({ ...base, to: TEST_POLICY, data });
    const parsed = parseTransaction(signed);
    expect(parsed.to?.toLowerCase()).toBe(TEST_POLICY.toLowerCase());
    expect(
      (await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toLowerCase(),
    ).toBe(other.address.toLowerCase());
  });
});

describe("the log scrubber", () => {
  it("hides agent tokens and token hashes in free text", () => {
    const token = `mdt_${"A".repeat(43)}`;
    const hash = "ab".repeat(32);
    const scrubbed = scrubText(`failed for ${token} with hash ${hash}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(hash);
  });
});
