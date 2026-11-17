import { join } from "node:path";
import { createPublicClient, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arcDoctor } from "../src/arc-doctor";
import {
  devAccount,
  deployPolicy,
  startAnvil,
  DEVCHAIN_DIR,
  type AnvilInstance,
  type Deployment,
} from "../src";

// Throwaway keys of the test's own: not anvil's published ones, which the doctor refuses for Arc.
const AGENT_KEY = `0x${"a1".repeat(32)}` as const;
const EXECUTOR_KEY = `0x${"e1".repeat(32)}` as const;
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const EXECUTOR = privateKeyToAccount(EXECUTOR_KEY).address;
const OWNER = devAccount("user").address;

let anvil: AnvilInstance;
let deployment: Deployment;

async function fund(address: Address, usdc: string): Promise<void> {
  const client = createPublicClient({ transport: http(anvil.rpcUrl) });
  await client.request({
    method: "anvil_setBalance" as never,
    params: [address, `0x${parseEther(usdc).toString(16)}`] as never,
  });
}

async function run(env: Record<string, string>, options: { owner?: string; artifactPath?: string } = {}) {
  const lines: string[] = [];
  const status = await arcDoctor({
    env: {
      ARC_RPC_URL: anvil.rpcUrl,
      POLICY_ADDRESS: deployment.address,
      POLICY_DEPLOY_BLOCK: deployment.blockNumber.toString(),
      AGENT_PRIVATE_KEY: AGENT_KEY,
      EXECUTOR_PRIVATE_KEY: EXECUTOR_KEY,
      ...env,
    },
    say: (line) => lines.push(line),
    owner: options.owner ?? OWNER,
    artifactPath: options.artifactPath,
    forkRpcUrl: anvil.rpcUrl,
  });
  const output = lines.join("\n");
  // Never a key, whatever the verdict.
  for (const key of [AGENT_KEY, EXECUTOR_KEY]) expect(output).not.toContain(key.slice(2, 18));
  return { status, output, verdict: lines.at(-1) ?? "" };
}

beforeAll(async () => {
  // The devchain shares Arc testnet's chain id, so a local anvil stands in for Arc here.
  anvil = await startAnvil({ port: 0 });
  deployment = await deployPolicy({
    rpcUrl: anvil.rpcUrl,
    contract: "production",
    agent: AGENT,
    executor: EXECUTOR,
  });
});

afterAll(async () => {
  await anvil.stop();
});

describe("arc:doctor", () => {
  it("asks for the faucet first while the keys hold their roles but no gas", async () => {
    const { status, output, verdict } = await run({});
    expect(status).toBe(1);
    expect(output).toContain("matches the compiled contracts/src/Policy.sol");
    expect(output).toContain("the contract appears in exactly this block");
    expect(output).toMatch(/agent {4}0x[0-9a-fA-F]{40} {2}matches/);
    expect(output).toMatch(/recordResult \(executor\) +\d+ gas/);
    expect(verdict).toBe(
      `NOT READY: fund the agent ${AGENT} with Arc testnet USDC at https://faucet.circle.com.`,
    );
  });

  it("is READY once both have gas, and says how many calls it covers", async () => {
    await fund(AGENT, "10");
    await fund(EXECUTOR, "10");
    const { status, output, verdict } = await run({});
    expect(verdict).toMatch(/^READY:/);
    expect(status).toBe(0);
    expect(output).toMatch(
      new RegExp(`agent +${AGENT} holds 10\\.000000 USDC, enough for \\d+ of its costliest call`),
    );
  });

  it("names the setter the owner must call when a key does not hold its role", async () => {
    const other = `0x${"b2".repeat(32)}`;
    const { status, verdict } = await run({ AGENT_PRIVATE_KEY: other });
    expect(status).toBe(1);
    expect(verdict).toBe(
      `NOT READY: ask the contract's owner to call setAgent(${privateKeyToAccount(other).address}).`,
    );
  });

  it("refuses anvil's published executor key, and says how to replace it", async () => {
    const anvilExecutor = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
    const { status, output } = await run({ EXECUTOR_PRIVATE_KEY: anvilExecutor });
    expect(status).toBe(1);
    expect(output).toContain("EXECUTOR_PRIVATE_KEY is one of anvil's published test keys");
    expect(output).toContain("npm run arc:keygen -- --replace");
    expect(output).not.toContain(anvilExecutor.slice(2, 18));
  });

  it("says when the code at the address is not the Policy built from this repository", async () => {
    const reference = join(DEVCHAIN_DIR, "out", "PolicyReference.sol", "PolicyReference.json");
    const { status, output } = await run({}, { artifactPath: reference });
    expect(status).toBe(1);
    expect(output).toContain("DIFFERS FROM the compiled contracts/src/Policy.sol");
  });

  it("checks the owner the operator names", async () => {
    const { status, verdict } = await run({}, { owner: AGENT });
    expect(status).toBe(1);
    expect(verdict).toContain(`the contract's owner (user) is ${OWNER}, not ${AGENT}`);
  });

  it("answers UNKNOWN, with only the host of a URL that may carry a key, when the RPC does not answer", async () => {
    const { status, output, verdict } = await run({ ARC_RPC_URL: "http://127.0.0.1:9/secret-api-key-path/" });
    expect(status).toBe(2);
    expect(verdict).toMatch(/^UNKNOWN:/);
    expect(output).not.toContain("secret-api-key-path");
  });
});
