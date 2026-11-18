import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArcDeployRefused,
  SET_POLICY_GAS_BOUND,
  SET_USER_GAS_BOUND,
  arcDeploy,
  checkDeployInputs,
  findDeployBlock,
  readContractState,
  type PolicyBuild,
} from "../src/arc-deploy";
import { arcDoctor } from "../src/arc-doctor";
import { DEMO_POLICY, PRODUCTION_OUT_DIR, devPrivateKey, startAnvil, type AnvilInstance } from "../src";

// Throwaway keys of the test's own: anvil's published keys are refused, as on Arc.
const AGENT_KEY = `0x${"a2".repeat(32)}` as const;
const EXECUTOR_KEY = `0x${"e2".repeat(32)}` as const;
const OWNER_KEY = `0x${"0c".repeat(32)}` as const;
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const EXECUTOR = privateKeyToAccount(EXECUTOR_KEY).address;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const ENV = { AGENT_PRIVATE_KEY: AGENT_KEY, EXECUTOR_PRIVATE_KEY: EXECUTOR_KEY };
const ARC = "https://rpc.testnet.arc.io";

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ArcDeployRefused) return error.message;
    throw error;
  }
  throw new Error("not refused");
}

describe("arc:deploy refuses before it reads the chain", () => {
  const check = (overrides: Partial<Parameters<typeof checkDeployInputs>[0]>) =>
    refusal(() => checkDeployInputs({ env: ENV, owner: OWNER, rpcUrl: ARC, fork: false, ...overrides }));

  it("accepts the owner's wallet with the two keys, and deploys from the executor's key", () => {
    const inputs = checkDeployInputs({ env: ENV, owner: OWNER.toLowerCase(), rpcUrl: ARC, fork: false });
    expect(inputs).toMatchObject({ owner: OWNER, agent: AGENT, executor: EXECUTOR });
    expect(inputs.deployer.address).toBe(EXECUTOR);
  });

  it("refuses without an owner, or with one that is not an address or is zero", () => {
    expect(check({ owner: undefined })).toMatch(/--owner 0x/);
    expect(check({ owner: "  " })).toMatch(/--owner 0x/);
    expect(check({ owner: "0x1234" })).toMatch(/is not an address/);
    expect(check({ owner: "0x0000000000000000000000000000000000000000" })).toMatch(/zero address/);
  });

  it("refuses an owner that is the agent or the executor", () => {
    expect(check({ owner: AGENT })).toMatch(/agent's address/);
    expect(check({ owner: EXECUTOR.toLowerCase() })).toMatch(/executor's address/);
  });

  it("refuses missing, malformed, shared and anvil's published keys", () => {
    expect(check({ env: { EXECUTOR_PRIVATE_KEY: EXECUTOR_KEY } })).toMatch(/AGENT_PRIVATE_KEY is not set/);
    expect(check({ env: { AGENT_PRIVATE_KEY: AGENT_KEY } })).toMatch(/EXECUTOR_PRIVATE_KEY is not set/);
    expect(check({ env: { ...ENV, AGENT_PRIVATE_KEY: "0x12" } })).toMatch(
      /AGENT_PRIVATE_KEY is not a private key/,
    );
    expect(check({ env: { AGENT_PRIVATE_KEY: AGENT_KEY, EXECUTOR_PRIVATE_KEY: AGENT_KEY } })).toMatch(
      /the same key/,
    );
    for (const variable of ["AGENT_PRIVATE_KEY", "EXECUTOR_PRIVATE_KEY"] as const) {
      const message = check({ env: { ...ENV, [variable]: devPrivateKey("executor") } });
      expect(message).toContain(`${variable} is one of anvil's published test keys`);
      expect(message).not.toContain(devPrivateKey("executor").slice(2, 18));
    }
  });

  it("refuses a loopback RPC unless --fork says it is a local fork", () => {
    expect(check({ rpcUrl: "http://127.0.0.1:8545" })).toMatch(/pass --fork/);
    expect(check({ rpcUrl: "http://localhost:8545" })).toMatch(/pass --fork/);
    expect(() =>
      checkDeployInputs({ env: ENV, owner: OWNER, rpcUrl: "http://127.0.0.1:8545", fork: true }),
    ).not.toThrow();
  });
});

describe("arc:deploy against a local chain", () => {
  let anvil: AnvilInstance;
  let build: PolicyBuild;
  const lines: string[] = [];
  const client = () => createPublicClient({ transport: http(anvil.rpcUrl) });

  async function fund(address: Address, usdc: string): Promise<void> {
    await client().request({
      method: "anvil_setBalance" as never,
      params: [address, `0x${parseEther(usdc).toString(16)}`] as never,
    });
  }

  function inputs() {
    return checkDeployInputs({ env: ENV, owner: OWNER, rpcUrl: anvil.rpcUrl, fork: true });
  }

  function run(options: { resume?: Address; allowAnother?: boolean; rpcUrl?: string } = {}) {
    return arcDeploy({
      ...inputs(),
      rpcUrl: options.rpcUrl ?? anvil.rpcUrl,
      build,
      say: (line) => lines.push(line),
      resume: options.resume,
      allowAnother: options.allowAnother ?? false,
      pollingMs: 50,
    });
  }

  async function runRefused(options: Parameters<typeof run>[0] = {}): Promise<string> {
    const nonce = await client().getTransactionCount({ address: EXECUTOR });
    const message = await run(options).then(
      () => "not refused",
      (error: unknown) => (error instanceof ArcDeployRefused ? error.message : String(error)),
    );
    // A refusal sends nothing.
    expect(await client().getTransactionCount({ address: EXECUTOR })).toBe(nonce);
    return message;
  }

  /** What a run that stopped after the deployment (or after setPolicy) leaves behind. */
  async function deployOnly(withRules: boolean): Promise<Address> {
    const wallet = createWalletClient({
      account: privateKeyToAccount(EXECUTOR_KEY),
      transport: http(anvil.rpcUrl),
    });
    const account = privateKeyToAccount(EXECUTOR_KEY);
    const hash = await wallet.sendTransaction({
      account,
      chain: null,
      data: encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [AGENT, EXECUTOR] }),
    });
    const receipt = await client().waitForTransactionReceipt({ hash, pollingInterval: 50 });
    const address = getAddress(receipt.contractAddress as Address);
    if (withRules) {
      const rules = await wallet.writeContract({
        account,
        chain: null,
        address,
        abi: build.abi,
        functionName: "setPolicy",
        args: [DEMO_POLICY],
      });
      await client().waitForTransactionReceipt({ hash: rules, pollingInterval: 50 });
    }
    return address;
  }

  beforeAll(async () => {
    const json = JSON.parse(readFileSync(join(PRODUCTION_OUT_DIR, "Policy.sol", "Policy.json"), "utf8")) as {
      abi: Abi;
      bytecode: { object: Hex };
      deployedBytecode: { object: Hex };
    };
    build = { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
    // The devchain shares Arc testnet's chain id, so a local anvil stands in for Arc here.
    anvil = await startAnvil({ port: 0 });
  });

  afterAll(async () => {
    await anvil.stop();
  });

  it("refuses a deployer without the gas for the three transactions, and sends nothing", async () => {
    await fund(EXECUTOR, "0.001");
    expect(await runRefused()).toMatch(/holds 0\.001000 USDC, less than the .* the run needs/);
  });

  it("deploys, sets the demo rules, hands the user role to the owner last, and the doctor says READY", async () => {
    await fund(EXECUTOR, "10");
    await fund(AGENT, "10");
    lines.length = 0;
    const result = await run();
    expect(result.sent.map((tx) => tx.step)).toEqual(["deploy", "setPolicy", "setUser"]);
    const state = await readContractState(client(), result.address, build.abi);
    expect(state).toEqual({ user: OWNER, agent: AGENT, executor: EXECUTOR, rules: DEMO_POLICY });
    expect(await findDeployBlock(client(), result.address)).toBe(result.deployBlock);

    // The calls that cannot be estimated ahead stay inside their bounds.
    const [, rules, user] = await Promise.all(
      result.sent.map((tx) => client().getTransactionReceipt({ hash: tx.hash })),
    );
    expect(rules?.gasUsed).toBeLessThan(SET_POLICY_GAS_BOUND);
    expect(user?.gasUsed).toBeLessThan(SET_USER_GAS_BOUND);

    const output = lines.join("\n");
    for (const tx of result.sent) expect(output).toContain(tx.hash);
    expect(output).toContain(`POLICY_ADDRESS=${result.address}`);
    expect(output).toContain(`POLICY_DEPLOY_BLOCK=${result.deployBlock.toString()}`);
    for (const key of [AGENT_KEY, EXECUTOR_KEY]) expect(output).not.toContain(key.slice(2, 18));

    const doctor: string[] = [];
    const status = await arcDoctor({
      env: {
        ARC_RPC_URL: anvil.rpcUrl,
        POLICY_ADDRESS: result.address,
        POLICY_DEPLOY_BLOCK: result.deployBlock.toString(),
        ...ENV,
      },
      say: (line) => doctor.push(line),
      owner: OWNER,
      artifactPath: join(PRODUCTION_OUT_DIR, "Policy.sol", "Policy.json"),
      forkRpcUrl: anvil.rpcUrl,
    });
    expect(doctor.at(-1)).toMatch(/^READY/);
    expect(status).toBe(0);
  });

  it("never deploys a second time by accident: it names the earlier contract, and --resume finds nothing missing", async () => {
    const earlier = lines.find((line) => line.startsWith("POLICY_ADDRESS="))?.slice("POLICY_ADDRESS=".length);
    expect(await runRefused()).toBe(
      `this key already deployed a Policy contract at ${earlier ?? "?"}: finish it with --resume ${earlier ?? "?"}, or pass --new to deploy another.`,
    );
    const nonce = await client().getTransactionCount({ address: EXECUTOR });
    const again = await run({ resume: earlier as Address });
    expect(again.sent).toEqual([]);
    expect(await client().getTransactionCount({ address: EXECUTOR })).toBe(nonce);
  });

  it("resumes a run that stopped after the deployment with setPolicy and setUser only", async () => {
    const address = await deployOnly(false);
    const result = await run({ resume: address });
    expect(result.sent.map((tx) => tx.step)).toEqual(["setPolicy", "setUser"]);
    expect(result.address).toBe(address);
    expect(await readContractState(client(), address, build.abi)).toMatchObject({
      user: OWNER,
      rules: DEMO_POLICY,
    });
  });

  it("resumes a run that stopped after setPolicy with setUser only", async () => {
    const address = await deployOnly(true);
    const result = await run({ resume: address });
    expect(result.sent.map((tx) => tx.step)).toEqual(["setUser"]);
  });

  it("refuses to resume what is not this deployment's Policy, or what someone else holds", async () => {
    expect(await runRefused({ resume: AGENT })).toMatch(/is not the Policy contract built from/);

    // A Policy whose user is a stranger: deployed by the owner's key, so neither the deployer nor --owner.
    await fund(privateKeyToAccount(OWNER_KEY).address, "10");
    const stranger = createWalletClient({
      account: privateKeyToAccount(OWNER_KEY),
      transport: http(anvil.rpcUrl),
    });
    const hash = await stranger.sendTransaction({
      account: privateKeyToAccount(OWNER_KEY),
      chain: null,
      data: encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [EXECUTOR, AGENT] }),
    });
    const receipt = await client().waitForTransactionReceipt({ hash, pollingInterval: 50 });
    const swapped = getAddress(receipt.contractAddress as Address);
    expect(await runRefused({ resume: swapped })).toMatch(/not this env file's/);
  });

  it("refuses a chain that is not Arc testnet", async () => {
    const other = await startAnvil({ port: 0, chainId: 31337 });
    try {
      await fund(EXECUTOR, "10");
      const message = await run({ rpcUrl: other.rpcUrl }).then(
        () => "not refused",
        (error: unknown) => (error instanceof ArcDeployRefused ? error.message : String(error)),
      );
      expect(message).toBe("the RPC serves chain 31337, not Arc testnet (5042002).");
    } finally {
      await other.stop();
    }
  });
});
