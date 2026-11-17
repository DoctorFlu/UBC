import { describe, expect, it } from "vitest";
import * as z from "zod";
import { assertToolRequirements } from "../src/app";
import { ConfigError, parseConfig, rpcHost } from "../src/config";
import { defineTool } from "../src/mcp/tool";
import { TEST_ADDRESS, TEST_PRIVATE_KEY, TEST_TOKEN, testConfig } from "./helpers";

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("applies defaults and treats blank values as unset", () => {
    const config = parseConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, POLICY_ADDRESS: "", AGENT_PRIVATE_KEY: "  " });
    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.policyAddress).toBeUndefined();
    expect(config.agentPrivateKey).toBeUndefined();
    expect(config.allowedOrigins).toEqual([]);
  });

  it("refuses to start without MCP_AUTH_TOKEN", () => {
    expect(problemsOf({})).toEqual([
      expect.stringMatching(/^MCP_AUTH_TOKEN: is not set\. Run `npm run mcp:token`/),
    ]);
  });

  it("refuses an MCP_AUTH_TOKEN shorter than 32 characters", () => {
    const problems = problemsOf({ MCP_AUTH_TOKEN: "short-token-value" });
    expect(problems).toEqual([expect.stringMatching(/^MCP_AUTH_TOKEN: must be at least 32 characters/)]);
    expect(problems.join("")).not.toContain("short-token-value");
  });

  it("accepts a token of exactly 32 characters", () => {
    expect(parseConfig({ MCP_AUTH_TOKEN: "a".repeat(32) }).authToken.reveal()).toHaveLength(32);
  });

  it("names every invalid variable without printing its value", () => {
    const problems = problemsOf({
      MCP_AUTH_TOKEN: TEST_TOKEN,
      MCP_PORT: "99999",
      ARC_RPC_URL: "not-a-url-secret",
      POLICY_ADDRESS: "0x1234",
      AGENT_PRIVATE_KEY: "0xnot-a-key-secret",
      SIGNALS_URL: "ftp://example.com",
    });
    expect(problems.map((problem) => problem.split(":")[0]).sort()).toEqual([
      "AGENT_PRIVATE_KEY",
      "ARC_RPC_URL",
      "MCP_PORT",
      "POLICY_ADDRESS",
      "SIGNALS_URL",
    ]);
    expect(problems.join("\n")).not.toContain("secret");
  });

  it("derives the agent address from the key", () => {
    expect(testConfig({ AGENT_PRIVATE_KEY: TEST_PRIVATE_KEY }).agentAddress).toBe(TEST_ADDRESS);
  });

  it("refuses a well-formed key that is not a valid secp256k1 scalar", () => {
    expect(problemsOf({ MCP_AUTH_TOKEN: TEST_TOKEN, AGENT_PRIVATE_KEY: `0x${"0".repeat(64)}` })).toEqual([
      "AGENT_PRIVATE_KEY: is not a valid secp256k1 private key",
    ]);
  });

  it("refuses one of anvil's published keys for Arc testnet, and takes it for a loopback devchain", () => {
    const anvilAgent = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const problems = problemsOf({ MCP_AUTH_TOKEN: TEST_TOKEN, AGENT_PRIVATE_KEY: anvilAgent });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^AGENT_PRIVATE_KEY is one of anvil's published test keys/);
    expect(problems[0]).toContain("rpc.testnet.arc.io");
    expect(problems.join("\n")).not.toContain(anvilAgent.slice(2, 14));
    expect(
      problemsOf({
        MCP_AUTH_TOKEN: TEST_TOKEN,
        AGENT_PRIVATE_KEY: anvilAgent,
        ARC_RPC_URL: "https://arc-testnet.example.quiknode.pro/abc/",
      }),
    ).toHaveLength(1);
    expect(
      testConfig({ AGENT_PRIVATE_KEY: anvilAgent, ARC_RPC_URL: "http://127.0.0.1:8545" }).agentAddress,
    ).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("parses allowed origins as a lowercase list", () => {
    expect(testConfig({ MCP_ALLOWED_ORIGINS: " Console.Example.com, ,b.example " }).allowedOrigins).toEqual([
      "console.example.com",
      "b.example",
    ]);
  });

  it("exposes only the RPC host, never its path", () => {
    expect(rpcHost(testConfig({ ARC_RPC_URL: "https://x.arc.example/secret-key/" }))).toBe("x.arc.example");
  });
});

describe("tool requirements", () => {
  const needsKey = defineTool({
    name: "needs_key",
    title: "Needs key",
    description: "Test tool",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    requires: ["AGENT_PRIVATE_KEY", "POLICY_ADDRESS"],
    handler: () => ({ structured: {}, summary: "" }),
  });

  it("requires only the variables that registered tools need", () => {
    expect(() => {
      assertToolRequirements(testConfig(), [needsKey]);
    }).toThrow(ConfigError);
    try {
      assertToolRequirements(testConfig(), [needsKey]);
    } catch (error) {
      expect((error as ConfigError).problems).toEqual([
        "AGENT_PRIVATE_KEY: is not set, and the needs_key tool requires it",
        "POLICY_ADDRESS: is not set, and the needs_key tool requires it",
      ]);
    }
    expect(() => {
      assertToolRequirements(testConfig(), []);
    }).not.toThrow();
  });
});
