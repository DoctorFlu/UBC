import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { KeygenRefused, ensureArcKeys, presentKey } from "../scripts/arc-keygen";

const ANVIL_AGENT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OWN = `0x${"4d".repeat(32)}`;

function envFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "arc-keygen-")), ".env");
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function keyOf(file: string, name: string): Hex {
  const found = presentKey(readFileSync(file, "utf8"), name);
  if (found.kind !== "key") throw new Error(`${name} is not a key`);
  return found.key;
}

describe("arc:keygen", () => {
  it("fills empty template lines with two new keys, keeps every other line, and returns only addresses", () => {
    const file = envFile("# Arc\nAGENT_PRIVATE_KEY=\nMCP_PORT=8787\n");
    const result = ensureArcKeys(file, { replace: false });
    const agent = keyOf(file, "AGENT_PRIVATE_KEY");
    const executor = keyOf(file, "EXECUTOR_PRIVATE_KEY");
    expect(agent).not.toBe(executor);
    expect(result.addresses).toEqual({
      agent: privateKeyToAccount(agent).address,
      executor: privateKeyToAccount(executor).address,
    });
    expect(readFileSync(file, "utf8")).toMatch(
      /^# Arc\nAGENT_PRIVATE_KEY=0x[0-9a-f]{64}\nMCP_PORT=8787\nEXECUTOR_PRIVATE_KEY=0x[0-9a-f]{64}\n$/,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const printed = result.lines.join("\n");
    expect(printed).not.toContain(agent.slice(2, 18));
    expect(printed).not.toContain(executor.slice(2, 18));
  });

  it("keeps keys that are there, and replaces them only with --replace", () => {
    const file = envFile(`AGENT_PRIVATE_KEY='${OWN}'\n`);
    const kept = ensureArcKeys(file, { replace: false });
    expect(keyOf(file, "AGENT_PRIVATE_KEY")).toBe(OWN);
    expect(kept.lines[0]).toContain("kept the existing AGENT_PRIVATE_KEY");
    const executor = keyOf(file, "EXECUTOR_PRIVATE_KEY");
    ensureArcKeys(file, { replace: false });
    expect(keyOf(file, "EXECUTOR_PRIVATE_KEY")).toBe(executor);

    const replaced = ensureArcKeys(file, { replace: true });
    expect(keyOf(file, "AGENT_PRIVATE_KEY")).not.toBe(OWN);
    expect(keyOf(file, "EXECUTOR_PRIVATE_KEY")).not.toBe(executor);
    expect(replaced.lines.every((line) => line.includes("replaced"))).toBe(true);
  });

  it.each([
    [`AGENT_PRIVATE_KEY=${ANVIL_AGENT}\n`, "anvil's published test keys"],
    ["EXECUTOR_PRIVATE_KEY=0x1234\n", "not a 32-byte hex private key"],
    [`AGENT_PRIVATE_KEY=${OWN}\nEXECUTOR_PRIVATE_KEY=${OWN}\n`, "the same key"],
  ])("refuses %j without --replace, changing nothing and quoting no key", (content, reason) => {
    const file = envFile(content);
    let refusal: unknown;
    try {
      ensureArcKeys(file, { replace: false });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(KeygenRefused);
    expect((refusal as Error).message).toContain(reason);
    expect((refusal as Error).message).toContain("--replace");
    expect((refusal as Error).message).not.toContain("4d4d4d4d");
    expect((refusal as Error).message).not.toContain(ANVIL_AGENT.slice(2, 18));
    expect(readFileSync(file, "utf8")).toBe(content);
    ensureArcKeys(file, { replace: true });
    expect(keyOf(file, "AGENT_PRIVATE_KEY")).not.toBe(ANVIL_AGENT);
  });

  it("prints the two addresses and the next steps, never a key, when run as a command", () => {
    const file = envFile("");
    const script = fileURLToPath(new URL("../scripts/arc-keygen.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", "tsx", script], {
      env: { ...process.env, ENV_FILE: file, INIT_CWD: "/" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const agent = privateKeyToAccount(keyOf(file, "AGENT_PRIVATE_KEY")).address;
    const executor = privateKeyToAccount(keyOf(file, "EXECUTOR_PRIVATE_KEY")).address;
    expect(run.stdout).toContain(`make ${agent} the agent and ${executor} the executor`);
    expect(run.stdout).toContain("npm run arc:doctor");
    expect(run.stdout + run.stderr).not.toContain(keyOf(file, "AGENT_PRIVATE_KEY").slice(2, 18));
    expect(run.stdout + run.stderr).not.toContain(keyOf(file, "EXECUTOR_PRIVATE_KEY").slice(2, 18));
  });
});
