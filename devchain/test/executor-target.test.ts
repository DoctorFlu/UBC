import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { arcTestnet, devchain, policyAbi } from "@mandate/shared";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExecutorConfigError,
  devAccount,
  deployPolicy,
  executorTarget,
  startAnvil,
  waitForExecutorRole,
  type AnvilInstance,
  type Deployment,
} from "../src";

const ANVIL_EXECUTOR = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
// A throwaway key of the test's own, not one of anvil's.
const OWN_KEY = `0x${"e7".repeat(32)}` as const;
const OWN = privateKeyToAccount(OWN_KEY).address;
const POLICY = "0x571D8ea7C86c80a230C10818743f8861084F82f3";

function envDeployment(rpcUrl: string, fromBlock: bigint | null = 72740419n) {
  return { source: "env" as const, address: POLICY as Address, chain: arcTestnet, rpcUrl, fromBlock };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("executorTarget", () => {
  it("uses anvil's executor account on the devchain's deployment file, whatever EXECUTOR_PRIVATE_KEY says", () => {
    const target = executorTarget(
      { EXECUTOR_PRIVATE_KEY: OWN_KEY },
      { source: "devchain", address: POLICY, chain: devchain, rpcUrl: "http://anvil:8545", fromBlock: 7n },
    );
    expect(target).toMatchObject({ local: true, deployBlock: 7n, network: "the local devchain" });
    expect(target.account.address).toBe(devAccount("executor").address);
  });

  it("signs with EXECUTOR_PRIVATE_KEY on Arc testnet, from POLICY_DEPLOY_BLOCK", () => {
    const target = executorTarget(
      { EXECUTOR_PRIVATE_KEY: ` '${OWN_KEY}' ` },
      envDeployment("https://rpc.testnet.arc.io"),
    );
    expect(target).toMatchObject({
      local: false,
      deployBlock: 72740419n,
      network: "Arc testnet (public RPC)",
    });
    expect(target.chain.id).toBe(5042002);
    expect(target.account.address).toBe(OWN);
  });

  it.each([
    ["https://rpc.testnet.arc.io", "Arc testnet (public RPC)"],
    ["https://example.arc-testnet.quiknode.pro/secret-key-path/", "example.arc-testnet.quiknode.pro"],
    ["http://anvil:8545", "anvil:8545"],
  ])(
    "refuses anvil's published executor key on %s, naming where it would sign and never the key",
    (rpcUrl, where) => {
      const message = refusal(() =>
        executorTarget({ EXECUTOR_PRIVATE_KEY: ANVIL_EXECUTOR }, envDeployment(rpcUrl)),
      );
      expect(message).toMatch(/^EXECUTOR_PRIVATE_KEY is one of anvil's published test keys/);
      expect(message).toContain(where);
      expect(message).toContain("npm run arc:keygen");
      expect(message).not.toContain("secret-key-path");
      expect(message).not.toContain(ANVIL_EXECUTOR.slice(2, 18));
    },
  );

  it("takes anvil's key for a contract of your own on a loopback RPC", () => {
    const target = executorTarget(
      { EXECUTOR_PRIVATE_KEY: ANVIL_EXECUTOR },
      envDeployment("http://127.0.0.1:8545", null),
    );
    expect(target).toMatchObject({ local: true, deployBlock: 0n });
  });

  it("refuses a missing or malformed key, and a missing deploy block off a loopback RPC", () => {
    const arc = envDeployment("https://rpc.testnet.arc.io");
    expect(refusal(() => executorTarget({}, arc))).toContain("EXECUTOR_PRIVATE_KEY is not set");
    expect(refusal(() => executorTarget({ EXECUTOR_PRIVATE_KEY: "0x1234" }, arc))).toContain("not a 32-byte");
    expect(
      refusal(() => executorTarget({ EXECUTOR_PRIVATE_KEY: OWN_KEY }, envDeployment(arc.rpcUrl, null))),
    ).toContain("POLICY_DEPLOY_BLOCK is not set");
  });
});

describe("waitForExecutorRole", () => {
  it("says once which setExecutor call is missing, re-reads every interval, and resolves when it is made", async () => {
    const answers: (Address | Error)[] = [
      devAccount("executor").address,
      devAccount("executor").address,
      new Error("HTTP request failed. URL: https://example.quiknode.pro/secret-key-path/"),
      OWN,
    ];
    const lines: string[] = [];
    const sleeps: number[] = [];
    await waitForExecutorRole({
      readExecutor: () => {
        const next = answers.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as Address);
      },
      executor: OWN,
      policy: POLICY,
      log: (line) => lines.push(line),
      redact: (text) => text.replace("https://example.quiknode.pro/secret-key-path/", "example.quiknode.pro"),
      recheckMs: 30_000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(lines).toEqual([
      `[executor] not the executor yet: ${POLICY} names ${devAccount("executor").address}, not this key's ${OWN}. Ask the contract's owner to call setExecutor(${OWN}); checking again every 30 s.`,
      `[executor] could not read ${POLICY}'s executor (HTTP request failed. URL: example.quiknode.pro); trying again every 30 s.`,
      `[executor] ${OWN} is now the executor of ${POLICY}.`,
    ]);
  });
});

describe("the executor script on a contract named by POLICY_ADDRESS", () => {
  let anvil: AnvilInstance;
  let deployment: Deployment;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ port: 0 });
    // Deployed with anvil's executor, as a fresh Arc deployment names its deployer.
    deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract: "production" });
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGINT");
    await anvil.stop();
  });

  /** Starts `npm run dev:executor` as a person would, and resolves with its output once `until` matches. */
  function runExecutor(until: RegExp): Promise<string> {
    const script = fileURLToPath(new URL("../scripts/executor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      env: {
        PATH: process.env.PATH,
        // No env file: only what is given here.
        ENV_FILE: "/nonexistent/mandate.env",
        POLICY_ADDRESS: deployment.address,
        POLICY_DEPLOY_BLOCK: deployment.blockNumber.toString(),
        ARC_RPC_URL: anvil.rpcUrl,
        EXECUTOR_PRIVATE_KEY: OWN_KEY,
        CONSOLE_URL: "http://127.0.0.1:9",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGINT");
        reject(new Error(`timed out waiting for ${String(until)}:\n${output}`));
      }, 8_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (until.test(output)) {
          clearTimeout(timer);
          child.kill("SIGINT");
          resolve(output);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!until.test(output))
          reject(new Error(`exited with ${String(code)} before ${String(until)}:\n${output}`));
      });
    });
  }

  it("waits with the owner's exact call while the key is not the executor, then serves once it is", async () => {
    const waiting = await runExecutor(/not the executor yet/);
    expect(waiting).toContain(`Ask the contract's owner to call setExecutor(${OWN})`);
    expect(waiting).not.toContain(OWN_KEY.slice(2, 18));

    const owner = createWalletClient({
      account: devAccount("user"),
      chain: { ...devchain, rpcUrls: { default: { http: [anvil.rpcUrl] } } },
      transport: http(anvil.rpcUrl),
    });
    await owner.writeContract({
      address: deployment.address,
      abi: policyAbi,
      functionName: "setExecutor",
      args: [OWN],
    });

    const serving = await runExecutor(/\[executor\] serving 0x/);
    expect(serving).toContain(`as ${OWN}`);
    expect(serving).toContain(
      `serving ${deployment.address.toLowerCase()} from block ${deployment.blockNumber.toString()}`,
    );
    expect(serving).not.toContain("not the executor yet");
  });
});
