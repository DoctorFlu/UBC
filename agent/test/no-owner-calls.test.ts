/**
 * Issue #11: the MCP server has no code path that changes the policy, pauses or unpauses, approves
 * or rejects an intent, changes a role, or records a result. Proven two ways:
 * 1. Structurally: the policy service tools see (`AgentPolicy`) has no such method, and the
 *    implementation's prototype has none either.
 * 2. By scanning every source file in the agent package for a call or an encoding of one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChainAgentPolicy } from "../src/chain/agent-policy";
import { createAppContext } from "../src/context";
import { silentLogger } from "../src/logger";
import type { AgentPolicy } from "../src/services";
import { TEST_POLICY, TEST_PRIVATE_KEY, testConfig } from "./helpers";

const OWNER_AND_EXECUTOR_FUNCTIONS = [
  "setPolicy",
  "setPaused",
  "setAgent",
  "setExecutor",
  "approveIntent",
  "rejectIntent",
  "recordResult",
] as const;

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js|mjs|json)$/.test(name) ? [path] : [];
  });
}

describe("no owner-only or executor-only calls from the agent", () => {
  it("the agent's policy service exposes reads, a preview and proposeTrade only", () => {
    // A compile-time check: adding an owner method to AgentPolicy makes this line fail to typecheck.
    type Forbidden = Extract<keyof AgentPolicy, (typeof OWNER_AND_EXECUTOR_FUNCTIONS)[number]>;
    const none: [Forbidden] extends [never] ? true : false = true;
    expect(none).toBe(true);

    const policy = createAppContext(
      testConfig({ POLICY_ADDRESS: TEST_POLICY, AGENT_PRIVATE_KEY: TEST_PRIVATE_KEY }),
      silentLogger,
    ).policy;
    expect(policy).toBeInstanceOf(ChainAgentPolicy);
    const methods = new Set([
      ...Object.getOwnPropertyNames(ChainAgentPolicy.prototype),
      ...Object.keys(policy ?? {}),
    ]);
    for (const name of OWNER_AND_EXECUTOR_FUNCTIONS) expect(methods.has(name)).toBe(false);
  });

  it("no source file in the agent package names an owner or executor function", () => {
    const files = sourceFiles(AGENT_ROOT).filter((file) => file !== THIS_FILE);
    expect(files.length).toBeGreaterThan(20);
    const pattern = new RegExp(`\\b(${OWNER_AND_EXECUTOR_FUNCTIONS.join("|")})\\b`);
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(AGENT_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("the agent's key is never used with a raw policy write", () => {
    // Writes go through PolicyClient.proposeTrade only; nothing in the agent encodes calldata itself.
    const files = sourceFiles(join(AGENT_ROOT, "src"));
    const offenders = files
      .filter((file) =>
        /\b(encodeFunctionData|writeContract|sendTransaction)\b/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(AGENT_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
