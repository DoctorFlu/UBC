import { describe, expect, it } from "vitest";
import { createAppContext, type ToolContext } from "../src/context";
import { silentLogger } from "../src/logger";
import { CallDeadline } from "../src/mcp/deadline";
import { toolContext } from "../src/mcp/tool";
import { ToolError } from "../src/mcp/errors";
import { getSetupState } from "../src/tools/get-setup-state";
import { tools } from "../src/tools";
import { whoami } from "../src/tools/whoami";
import { fixedClock, TEST_ADDRESS, TEST_POLICY, TEST_PRIVATE_KEY, testConfig } from "./helpers";

/** Tools are plain objects: call `run` with a fake context, no server or transport needed. */
function fakeContext(env: Record<string, string> = {}): ToolContext {
  const app = createAppContext(testConfig(env), silentLogger, { clock: fixedClock });
  return toolContext(app, new CallDeadline({ budgetMs: 25_000 }), { requestId: "test" });
}

describe("registry", () => {
  it("has unique snake_case names and complete descriptions", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });
});

describe("get_setup_state", () => {
  it("lists every step as owner work on a bare configuration", async () => {
    const { structured, summary } = await getSetupState.run({}, fakeContext());
    expect(structured).toMatchObject({ ready: false });
    expect(structured["steps"]).toEqual([
      expect.objectContaining({ key: "agent_key", done: false, actor: "owner" }),
      expect.objectContaining({ key: "policy_contract", done: false, actor: "owner" }),
      expect.objectContaining({ key: "console_link", done: false, actor: "owner" }),
    ]);
    expect(summary).toMatch(/^0 of 3 setup steps done\. Left: owner: Set AGENT_PRIVATE_KEY/);
    expect(structured["nextAction"]).toMatchObject({
      actor: "owner",
      hint: expect.stringContaining("AGENT_PRIVATE_KEY") as unknown,
    });
  });

  it("never suggests pasting a key into chat", async () => {
    const { structured } = await getSetupState.run({}, fakeContext());
    const hints = (structured["steps"] as { hint: string }[]).map((step) => step.hint).join(" ");
    expect(hints).toContain("Never paste a key into chat");
  });
});

describe("whoami", () => {
  it("reports the public Arc testnet RPC host when ARC_RPC_URL is not set", async () => {
    const { structured } = await whoami.run({}, fakeContext());
    expect(structured["chain"]).toEqual({ rpcHost: "rpc.testnet.arc.io" });
  });

  it("derives capabilities from the configuration", async () => {
    const { structured } = await whoami.run(
      {},
      fakeContext({
        ARC_RPC_URL: "https://rpc.testnet.arc.network/some/key/path",
        AGENT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        POLICY_ADDRESS: TEST_POLICY,
      }),
    );
    expect(structured).toEqual({
      agentAddress: TEST_ADDRESS,
      chain: { rpcHost: "rpc.testnet.arc.network" },
      policyAddress: TEST_POLICY,
      capabilities: { readPolicy: true, proposeTrades: true, console: false },
    });
  });

  it("rejects unexpected input types with INVALID_INPUT", async () => {
    await expect(whoami.run("not an object", fakeContext())).rejects.toMatchObject({
      constructor: ToolError,
      code: "INVALID_INPUT",
    });
  });
});
