/**
 * The Arc doctor (`npm run arc:doctor`, issue #23): checks that the stack can run against the Policy
 * contract on Arc testnet before it does, and says the one next step when it cannot. Run it after every
 * change of keys, gas or roles (`setUser`, `setAgent`, `setExecutor`): the roles are mutable.
 *
 * Read-only on Arc: it sends no transaction there. It prints no key and no secret, and of the RPC URL only
 * its host (a provider's URL may carry an API key in its path).
 *
 * The gas a proposal, an approval and a `recordResult` cost is measured, not guessed: on a local anvil fork
 * of Arc testnet at the current block, as the contract's own role holders (impersonated, unsigned), with
 * a known rule set. The fork reads Arc's public RPC, never the configured one, so it spends no provider
 * credits and no API key reaches a process's argument list. Nothing done on the fork reaches Arc.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARC_MIN_MAX_FEE_PER_GAS, ARC_TESTNET, applyFeeFloor } from "@mandate/shared";
import { wellKnownKeyRefusal } from "@mandate/shared/node";
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil } from "./anvil";
import { PRODUCTION_OUT_DIR, buildContracts } from "./foundry";

/** 0 ready, 1 not ready (the next step is printed), 2 Arc could not be reached. */
export type ArcDoctorStatus = 0 | 1 | 2;

export interface ArcDoctorOptions {
  env: Record<string, string | undefined>;
  say: (line: string) => void;
  /** The owner's address, as the operator names it (`--owner` or `ARC_OWNER_ADDRESS`). */
  owner?: string | undefined;
  /** The compiled contract to compare with; defaults to the production build under devchain/out. */
  artifactPath?: string | undefined;
  /** The RPC the fork reads. Defaults to Arc's public RPC; tests pass a local chain. */
  forkRpcUrl?: string;
  /** False skips the fork and its gas figures (`--no-fork`). */
  fork?: boolean;
}

/** Gas figures of one operation: measured units, and what one costs at today's fee. */
interface GasFigure {
  label: string;
  role: "agent" | "user" | "executor";
  gas: bigint;
}

/** Each operation is budgeted with this headroom over what the fork measured. */
const HEADROOM_PERCENT = 120n;
/** A role is ready when its gas covers at least this many of its operations. */
export const MIN_OPERATIONS = 10n;

/** The rules the fork sets before it measures, so the three paths exist whatever the live rules are. */
const MEASURE_RULES = {
  budgetCents: 20_000n,
  maxTradeCents: 2_500n,
  allowedCategories: 1n,
  approvalAboveCents: 1_000n,
  dailyLossCents: 0n,
  paused: false,
} as const;
const MEASURE_MARKET = "GEMI-BTC2611302200-HI67500";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
}

function usdc(wei: bigint): string {
  const text = formatUnits(wei, 18);
  const [whole = "0", fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(6, "0").slice(0, 6)} USDC`;
}

function keyAddress(env: Record<string, string | undefined>, name: string): Address | "invalid" | null {
  const value = env[name]?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "";
  if (value === "") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return "invalid";
  try {
    return privateKeyToAccount(value as Hex).address;
  } catch {
    return "invalid";
  }
}

interface Artifact {
  abi: Abi;
  deployedBytecode: Hex;
}

function loadArtifact(path: string): Artifact | null {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; deployedBytecode: { object: Hex } };
    return { abi: json.abi, deployedBytecode: json.deployedBytecode.object };
  } catch {
    return null;
  }
}

export const DEFAULT_ARTIFACT = join(PRODUCTION_OUT_DIR, "Policy.sol", "Policy.json");

export async function arcDoctor(options: ArcDoctorOptions): Promise<ArcDoctorStatus> {
  const { env, say } = options;
  const steps: string[] = [];
  const notes: string[] = [];
  const finish = (status: ArcDoctorStatus, verdict: string): ArcDoctorStatus => {
    say("");
    for (const note of notes) say(`Note: ${note}`);
    if (notes.length > 0) say("");
    say(verdict);
    return status;
  };

  // ------------------------------------------------------------------ settings
  const rpcUrl = env.ARC_RPC_URL?.trim() || ARC_TESTNET.rpcUrl;
  const publicRpc = rpcUrl === ARC_TESTNET.rpcUrl;
  const policyText = env.POLICY_ADDRESS?.trim() ?? "";
  const deployBlockText = env.POLICY_DEPLOY_BLOCK?.trim() ?? "";
  const agentKey = keyAddress(env, "AGENT_PRIVATE_KEY");
  const executorKey = keyAddress(env, "EXECUTOR_PRIVATE_KEY");
  const ownerText = options.owner?.trim() || env.ARC_OWNER_ADDRESS?.trim() || "";
  const describeKey = (key: Address | "invalid" | null) =>
    key === null ? "not set" : key === "invalid" ? "set, but not a private key" : `set, address ${key}`;
  say(
    `ARC_RPC_URL:          ${publicRpc ? `${rpcUrl} (Arc's public RPC, the default)` : `set, host ${hostOf(rpcUrl)}`}`,
  );
  say(`POLICY_ADDRESS:       ${policyText || "not set"}`);
  say(`POLICY_DEPLOY_BLOCK:  ${deployBlockText || "not set"}`);
  say(`AGENT_PRIVATE_KEY:    ${describeKey(agentKey)}`);
  say(`EXECUTOR_PRIVATE_KEY: ${describeKey(executorKey)}`);
  say(`Owner (named by you): ${ownerText || "not named (pass --owner 0x... or set ARC_OWNER_ADDRESS)"}`);

  if (!isAddress(policyText)) {
    return finish(
      1,
      "NOT READY: set POLICY_ADDRESS (and POLICY_DEPLOY_BLOCK) to the Arc testnet deployment in contracts/README.md.",
    );
  }
  if (!/^\d+$/.test(deployBlockText)) {
    return finish(
      1,
      "NOT READY: set POLICY_DEPLOY_BLOCK to the contract's deploy block (contracts/README.md), so the console never scans Arc from block 0.",
    );
  }
  if (ownerText !== "" && !isAddress(ownerText))
    return finish(1, "NOT READY: the owner you named is not an address.");
  const policy = getAddress(policyText);
  const deployBlock = BigInt(deployBlockText);
  const owner = ownerText === "" ? null : getAddress(ownerText);

  // Compiled from this checkout's contracts/src/Policy.sol now (forge caches), so an old build never
  // decides whether the deployed code matches.
  if (options.artifactPath === undefined) {
    try {
      buildContracts();
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
      return finish(1, `NOT READY: contracts/src/Policy.sol could not be compiled (${reason}). Run npm ci.`);
    }
  }
  const artifact = loadArtifact(options.artifactPath ?? DEFAULT_ARTIFACT);
  if (artifact === null) {
    return finish(
      1,
      "NOT READY: the compiled Policy contract is missing. Run npm ci, then the doctor again.",
    );
  }
  const client: PublicClient = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
  });
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: policy, abi: artifact.abi, functionName, args }) as Promise<T>;

  try {
    // ---------------------------------------------------------------- 1. the chain
    say("");
    say("1. Which chain does the RPC serve?");
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    say(`   chain id ${String(chainId)}, head block ${head.toString()}`);
    if (chainId !== ARC_TESTNET.chainId) {
      return finish(
        1,
        `NOT READY: the RPC serves chain ${String(chainId)}, not Arc testnet (${String(ARC_TESTNET.chainId)}). Fix ARC_RPC_URL.`,
      );
    }

    // ---------------------------------------------------------------- 2. the contract
    say("");
    say(
      "2. Is POLICY_ADDRESS the Policy contract built from this repository, deployed at POLICY_DEPLOY_BLOCK?",
    );
    const code = await client.getCode({ address: policy });
    if (!code || code === "0x")
      return finish(1, `NOT READY: there is no contract at ${policy} on Arc testnet. Check POLICY_ADDRESS.`);
    const matches = keccak256(code) === keccak256(artifact.deployedBytecode);
    say(
      `   runtime code ${String((code.length - 2) / 2)} bytes, keccak ${keccak256(code).slice(0, 18)}…: ${matches ? "matches" : "DIFFERS FROM"} the compiled contracts/src/Policy.sol`,
    );
    if (!matches) {
      steps.push(
        "the contract at POLICY_ADDRESS is not the Policy built from this repository: check POLICY_ADDRESS against contracts/README.md, or rebuild (npm run dev:chain) after pulling main",
      );
    }
    const [before, at] = await Promise.all([
      deployBlock > 0n
        ? client.getCode({ address: policy, blockNumber: deployBlock - 1n })
        : Promise.resolve(undefined),
      client.getCode({ address: policy, blockNumber: deployBlock }),
    ]);
    const deployedAtBlock = (!before || before === "0x") && Boolean(at && at !== "0x");
    say(
      `   deploy block ${deployBlock.toString()}: ${deployedAtBlock ? "the contract appears in exactly this block" : "the contract does not appear in this block"}`,
    );
    if (!deployedAtBlock)
      steps.push(
        "POLICY_DEPLOY_BLOCK is not the block the contract was deployed in: take it from contracts/README.md",
      );
    say(`   blocks since deployment: ${(head - deployBlock).toString()}`);

    // ---------------------------------------------------------------- 3. roles
    say("");
    say("3. Do the contract's roles name the configured keys?");
    const [user, agent, executor] = await Promise.all([
      read<Address>("user"),
      read<Address>("agent"),
      read<Address>("executor"),
    ]);
    const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
    const roleLine = (
      name: string,
      onChain: Address,
      expected: Address | "invalid" | null,
      source: string,
    ) => {
      const verdict =
        expected === null
          ? `${source} not set`
          : expected === "invalid"
            ? `${source} is not a key`
            : same(onChain, expected)
              ? "matches"
              : `expected ${expected}`;
      say(`   ${name.padEnd(9)}${onChain}  ${verdict}`);
    };
    roleLine("user", user, owner, "owner");
    roleLine("agent", agent, agentKey, "AGENT_PRIVATE_KEY");
    roleLine("executor", executor, executorKey, "EXECUTOR_PRIVATE_KEY");
    if (agentKey === null || executorKey === null || agentKey === "invalid" || executorKey === "invalid") {
      steps.push("run npm run arc:keygen to put an agent and an executor key in the env file");
    }
    for (const [name, key] of [
      ["AGENT_PRIVATE_KEY", env.AGENT_PRIVATE_KEY],
      ["EXECUTOR_PRIVATE_KEY", env.EXECUTOR_PRIVATE_KEY],
    ] as const) {
      const refusal = key
        ? wellKnownKeyRefusal(name, key.trim().replace(/^(['"])(.*)\1$/, "$2"), {
            local: false,
            network: "Arc testnet",
          })
        : null;
      if (refusal) steps.push(`${refusal.replace(/\.$/, "")} (npm run arc:keygen -- --replace)`);
    }
    if (agentKey !== null && agentKey !== "invalid" && !same(agent, agentKey)) {
      steps.push(`ask the contract's owner to call setAgent(${agentKey})`);
    }
    if (executorKey !== null && executorKey !== "invalid" && !same(executor, executorKey)) {
      steps.push(`ask the contract's owner to call setExecutor(${executorKey})`);
    }
    if (owner !== null && !same(user, owner)) {
      steps.push(
        `the contract's owner (user) is ${user}, not ${owner}: the current owner calls setUser(${owner}), or name the right owner`,
      );
    }
    // The owner's role decides who approves and changes the rules: never READY without checking it.
    if (owner === null) {
      steps.push(
        `name the owner's wallet with --owner 0x... (or ARC_OWNER_ADDRESS), so the doctor can check the contract's user, now ${user}`,
      );
    }

    // ---------------------------------------------------------------- 4. rules and budget
    say("");
    say("4. What do the rules allow?");
    const rules = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>("policy");
    const [remaining, committed, lossToday, intents] = await Promise.all([
      read<bigint>("remainingBudgetCents"),
      read<bigint>("committedCents"),
      read<bigint>("lossTodayCents"),
      read<bigint>("intentCount"),
    ]);
    const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;
    say(`   budget ${dollars(rules[0])}, used ${dollars(committed)}, left ${dollars(remaining)}`);
    say(
      `   largest trade ${dollars(rules[1])}, owner approval above ${rules[3] === 0n ? "never" : dollars(rules[3])}, daily loss limit ${rules[4] === 0n ? "off" : dollars(rules[4])} (lost today ${dollars(lossToday)})`,
    );
    say(
      `   categories bitmask ${rules[2].toString()}, ${rules[5] ? "PAUSED" : "not paused"}, ${intents.toString()} intents so far`,
    );
    if (rules[5])
      notes.push("the contract is paused: proposals are recorded and rejected until the owner resumes it");
    if (remaining === 0n)
      notes.push("no budget is left: every buy will be rejected until the owner raises it");

    // ---------------------------------------------------------------- 5. gas
    say("");
    say("5. Gas (Arc pays it in USDC, 18 decimals natively)");
    const estimate = await client.estimateFeesPerGas({ type: "eip1559", chain: null }).catch(() => null);
    const fees = applyFeeFloor(
      estimate ?? { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      ARC_MIN_MAX_FEE_PER_GAS,
    );
    say(`   max fee per gas ${formatUnits(fees.maxFeePerGas, 9)} gwei (Arc drops anything under 20 gwei)`);
    let figures: GasFigure[] | null = null;
    if (options.fork !== false) {
      const forkRpc = options.forkRpcUrl ?? ARC_TESTNET.rpcUrl;
      say(
        `   measuring on a local fork of block ${head.toString()} (reads ${hostOf(forkRpc)}; nothing is sent to Arc)...`,
      );
      figures = await measureOnFork(forkRpc, head, policy, artifact.abi, { user, agent, executor }).catch(
        (error: unknown) => {
          notes.push(
            `the fork could not measure gas (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); run again, or use --no-fork`,
          );
          return null;
        },
      );
    }
    if (figures) {
      for (const figure of figures) {
        say(
          `   ${figure.label.padEnd(36)}${figure.gas.toString().padStart(8)} gas, ${usdc(figure.gas * fees.maxFeePerGas)} at most`,
        );
      }
    }
    const holders: { role: GasFigure["role"]; label: string; address: Address | null }[] = [
      {
        role: "agent",
        label: "agent",
        address: agentKey !== null && agentKey !== "invalid" ? agentKey : null,
      },
      {
        role: "executor",
        label: "executor",
        address: executorKey !== null && executorKey !== "invalid" ? executorKey : null,
      },
      { role: "user", label: "owner", address: owner },
    ];
    for (const holder of holders) {
      if (holder.address === null) continue;
      const balance = await client.getBalance({ address: holder.address });
      const costliest =
        figures?.filter((f) => f.role === holder.role).reduce((max, f) => (f.gas > max ? f.gas : max), 0n) ??
        0n;
      const each = (costliest * HEADROOM_PERCENT * fees.maxFeePerGas) / 100n;
      const covers = each > 0n ? balance / each : null;
      say(
        `   ${holder.label.padEnd(9)}${holder.address} holds ${usdc(balance)}${covers === null ? "" : `, enough for ${covers.toString()} of its costliest call`}`,
      );
      if (holder.role !== "user" && (balance === 0n || (covers !== null && covers < MIN_OPERATIONS))) {
        steps.push(
          `fund the ${holder.label} ${holder.address} with Arc testnet USDC at https://faucet.circle.com`,
        );
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
    // The URL may carry a key: only its host is ever printed.
    return finish(
      2,
      `UNKNOWN: Arc testnet did not answer (${reason.replaceAll(rpcUrl, hostOf(rpcUrl))}). Run the doctor again in a minute.`,
    );
  }

  if (steps.length > 0) {
    say("");
    say("Next steps, in order:");
    steps.forEach((step, index) => {
      say(`   ${String(index + 1)}. ${step}`);
    });
    return finish(1, `NOT READY: ${steps[0] ?? ""}.`);
  }
  return finish(
    0,
    "READY: the keys hold their roles and gas on the deployed Policy contract. Start the stack against Arc (docs/hosting.md, Arc testnet).",
  );
}

/**
 * Proposal, approval and `recordResult` on a fork of `block`: sets known rules as the user, then proposes
 * once above the approval line (approved by the user) and once below it (approved by the contract), and
 * records a result. Returns the gas each used.
 */
async function measureOnFork(
  forkRpcUrl: string,
  block: bigint,
  policy: Address,
  abi: Abi,
  roles: { user: Address; agent: Address; executor: Address },
): Promise<GasFigure[]> {
  const anvil = await startAnvil({ port: 0, fork: { rpcUrl: forkRpcUrl, block }, autoImpersonate: true });
  try {
    const transport = http(anvil.rpcUrl);
    const fork = createPublicClient({ transport, pollingInterval: 50 });
    const chain = { ...ARC_TESTNET_VIEM_CHAIN, rpcUrls: { default: { http: [anvil.rpcUrl] } } };
    for (const address of Object.values(roles)) {
      await fork.request({
        method: "anvil_setBalance" as never,
        params: [address, `0x${parseEther("10").toString(16)}`] as never,
      });
    }
    const send = async (from: Address, functionName: string, args: readonly unknown[]) => {
      const wallet = createWalletClient({ account: from, chain, transport });
      const hash = await wallet.writeContract({
        address: policy,
        abi,
        functionName,
        args,
        account: from,
        chain,
      });
      const receipt = await fork.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted on the fork`);
      return receipt.gasUsed;
    };
    const count = async () =>
      (await fork.readContract({ address: policy, abi, functionName: "intentCount" })) as bigint;
    const rules = [MEASURE_RULES] as const;
    await send(roles.user, "setPolicy", rules);
    const context = keccak256("0x6172632d646f63746f72");
    const held = await send(roles.agent, "proposeTrade", [
      MEASURE_MARKET,
      0,
      "YES",
      true,
      2_000n,
      40n,
      context,
    ]);
    const heldId = (await count()) - 1n;
    const approve = await send(roles.user, "approveIntent", [heldId]);
    const auto = await send(roles.agent, "proposeTrade", [
      MEASURE_MARKET,
      0,
      "YES",
      true,
      500n,
      40n,
      context,
    ]);
    const record = await send(roles.executor, "recordResult", [heldId, true, 2_000n, -100n]);
    return [
      { label: "proposal, held for the owner", role: "agent", gas: held },
      { label: "proposal, approved by the rules", role: "agent", gas: auto },
      { label: "owner approval", role: "user", gas: approve },
      { label: "recordResult (executor)", role: "executor", gas: record },
    ];
  } finally {
    await anvil.stop();
  }
}

/** viem's chain object for Arc testnet, only what a wallet client needs on the fork. */
const ARC_TESTNET_VIEM_CHAIN = {
  id: ARC_TESTNET.chainId,
  name: "Arc testnet (fork)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
} as const;
