/**
 * Our own instance of the Policy contract on Arc testnet (`npm run arc:deploy`): the same three
 * transactions as `contracts/script/Deploy.s.sol`, from the compiled `contracts/src/Policy.sol` the doctor
 * compares against. `new Policy(agent, executor)`, then `setPolicy` with the demo rules, then
 * `setUser(owner)` last, so the deployer is the contract's user only between its first and last
 * transaction.
 *
 * The deployer is the executor's key. It is funded, and the executor's role grants no power over the rules:
 * the agent's key must never hold the user role, even for a moment, because the agent proposes the trades
 * the user's rules judge (and the agent package is barred from naming owner calls).
 *
 * Resumable and idempotent: a run reads the chain first and sends only what is missing. A contract already
 * deployed by this key is found from the key's own nonces, so a second run never deploys again by accident.
 */
import { ARC_MIN_MAX_FEE_PER_GAS, ARC_TESTNET, applyFeeFloor, type PolicyRules } from "@mandate/shared";
import { isLoopbackUrl, wellKnownKeyRefusal } from "@mandate/shared/node";
import {
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatUnits,
  getAddress,
  getContractAddress,
  http,
  isAddress,
  keccak256,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_POLICY } from "./deploy";

/** A run that must not go ahead, with the reason in one sentence. Nothing has been sent when it is thrown. */
export class ArcDeployRefused extends Error {
  override name = "ArcDeployRefused";
}

export interface PolicyBuild {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

/**
 * Gas bounds for the two calls that cannot be estimated before the contract exists, over what they used on
 * the devchain (see the test, which checks they hold).
 */
export const SET_POLICY_GAS_BOUND = 200_000n;
export const SET_USER_GAS_BOUND = 60_000n;
/** The balance must cover the three transactions with this headroom over the estimate. */
const HEADROOM_PERCENT = 150n;
/** How many of the deployer's latest nonces are searched for a Policy it already created. */
export const EARLIER_DEPLOY_SEARCH = 64;

export interface ArcDeployInputs {
  owner: Address;
  agent: Address;
  executor: Address;
  deployer: PrivateKeyAccount;
}

function unquote(value: string | undefined): string {
  return value?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "";
}

function accountFrom(variable: string, value: string): PrivateKeyAccount {
  if (value === "") {
    throw new ArcDeployRefused(`${variable} is not set: run npm run arc:keygen first.`);
  }
  const refusal = wellKnownKeyRefusal(variable, value, { local: false, network: "Arc testnet" });
  if (refusal) throw new ArcDeployRefused(refusal);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ArcDeployRefused(`${variable} is not a private key (0x and 64 hex digits).`);
  }
  return privateKeyToAccount(value as Hex);
}

/**
 * Checks everything that needs no chain: the owner, the two keys and the RPC. Throws `ArcDeployRefused`.
 * The keys come from the environment the process loaded from the env file, never from the command line.
 */
export function checkDeployInputs(options: {
  env: Record<string, string | undefined>;
  owner: string | undefined;
  rpcUrl: string;
  /** `--fork`: the RPC is a local fork of Arc, so a loopback RPC is expected. */
  fork: boolean;
}): ArcDeployInputs {
  const ownerText = options.owner?.trim() ?? "";
  if (ownerText === "") {
    throw new ArcDeployRefused(
      "name the owner's wallet with --owner 0x...: setUser(owner) is the run's last transaction.",
    );
  }
  if (!isAddress(ownerText)) throw new ArcDeployRefused(`--owner ${ownerText} is not an address.`);
  const owner = getAddress(ownerText);
  if (owner === zeroAddress) throw new ArcDeployRefused("--owner is the zero address.");

  const agent = accountFrom("AGENT_PRIVATE_KEY", unquote(options.env.AGENT_PRIVATE_KEY));
  const deployer = accountFrom("EXECUTOR_PRIVATE_KEY", unquote(options.env.EXECUTOR_PRIVATE_KEY));
  if (agent.address === deployer.address) {
    throw new ArcDeployRefused("AGENT_PRIVATE_KEY and EXECUTOR_PRIVATE_KEY are the same key.");
  }
  if (owner === agent.address) {
    throw new ArcDeployRefused("--owner is the agent's address: the agent must never hold the user role.");
  }
  if (owner === deployer.address) {
    throw new ArcDeployRefused(
      "--owner is the executor's address: the owner must be the owner's own wallet.",
    );
  }
  if (isLoopbackUrl(options.rpcUrl) && !options.fork) {
    throw new ArcDeployRefused(
      "ARC_RPC_URL is a loopback address: pass --fork if it is a local fork of Arc testnet.",
    );
  }
  return { owner, agent: agent.address, executor: deployer.address, deployer };
}

export interface ContractState {
  user: Address;
  agent: Address;
  executor: Address;
  rules: PolicyRules;
}

export interface ArcDeployResult {
  address: Address;
  deployBlock: bigint;
  /** The transactions this run sent, in order. Empty when nothing was missing. */
  sent: { step: "deploy" | "setPolicy" | "setUser"; hash: Hex }[];
}

function sameRules(a: PolicyRules, b: PolicyRules): boolean {
  return (
    a.budgetCents === b.budgetCents &&
    a.maxTradeCents === b.maxTradeCents &&
    a.allowedCategories === b.allowedCategories &&
    a.approvalAboveCents === b.approvalAboveCents &&
    a.dailyLossCents === b.dailyLossCents &&
    a.paused === b.paused
  );
}

function usdc(wei: bigint): string {
  const [whole = "0", fraction = ""] = formatUnits(wei, 18).split(".");
  return `${whole}.${fraction.padEnd(6, "0").slice(0, 6)} USDC`;
}

export async function readContractState(
  client: PublicClient,
  address: Address,
  abi: Abi,
): Promise<ContractState> {
  const read = <T>(functionName: string) => client.readContract({ address, abi, functionName }) as Promise<T>;
  const [user, agent, executor, rules] = await Promise.all([
    read<Address>("user"),
    read<Address>("agent"),
    read<Address>("executor"),
    read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>("policy"),
  ]);
  return {
    user: getAddress(user),
    agent: getAddress(agent),
    executor: getAddress(executor),
    rules: {
      budgetCents: Number(rules[0]),
      maxTradeCents: Number(rules[1]),
      allowedCategories: Number(rules[2]),
      approvalAboveCents: Number(rules[3]),
      dailyLossCents: Number(rules[4]),
      paused: rules[5],
    },
  };
}

async function isOurPolicy(client: PublicClient, address: Address, build: PolicyBuild): Promise<boolean> {
  const code = await client.getCode({ address });
  return Boolean(code && code !== "0x" && keccak256(code) === keccak256(build.deployedBytecode));
}

/** The first block in which `address` has code: a binary search over historical state. */
export async function findDeployBlock(client: PublicClient, address: Address): Promise<bigint> {
  let low = 0n;
  let high = await client.getBlockNumber();
  const hasCode = async (blockNumber: bigint) => {
    const code = await client.getCode({ address, blockNumber });
    return Boolean(code && code !== "0x");
  };
  if (!(await hasCode(high))) throw new ArcDeployRefused(`there is no contract at ${address}.`);
  while (low < high) {
    const middle = (low + high) / 2n;
    if (await hasCode(middle)) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/** A Policy of this build that `deployer` already created, found from its latest nonces; null if none. */
export async function earlierDeployment(
  client: PublicClient,
  deployer: Address,
  build: PolicyBuild,
): Promise<Address | null> {
  const nonce = await client.getTransactionCount({ address: deployer, blockTag: "pending" });
  for (let n = nonce - 1; n >= Math.max(0, nonce - EARLIER_DEPLOY_SEARCH); n--) {
    const address = getContractAddress({ from: deployer, nonce: BigInt(n) });
    if (await isOurPolicy(client, address, build)) return address;
  }
  return null;
}

export interface ArcDeployOptions extends ArcDeployInputs {
  rpcUrl: string;
  build: PolicyBuild;
  say: (line: string) => void;
  /** `--resume 0x...`: the contract a stopped run deployed. Only the missing steps are sent. */
  resume?: Address | undefined;
  /** `--new`: deploy although this key already created a Policy (named in the refusal otherwise). */
  allowAnother?: boolean;
  rules?: PolicyRules;
  pollingMs?: number;
}

/** Runs the deployment, or what is missing of it. Throws `ArcDeployRefused` before sending anything. */
export async function arcDeploy(options: ArcDeployOptions): Promise<ArcDeployResult> {
  const { build, say, deployer, owner, agent, executor } = options;
  const rules = options.rules ?? DEMO_POLICY;
  const transport = http(options.rpcUrl, { timeout: 30_000, retryCount: 1 });
  const client = createPublicClient({ transport, pollingInterval: options.pollingMs ?? 500 });

  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET.chainId) {
    throw new ArcDeployRefused(
      `the RPC serves chain ${String(chainId)}, not Arc testnet (${String(ARC_TESTNET.chainId)}).`,
    );
  }
  const chain = {
    id: ARC_TESTNET.chainId,
    name: "Arc testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  } as const;
  const wallet = createWalletClient({ account: deployer, chain, transport });

  // ------------------------------------------------------------------ what is there already
  let address: Address | null = null;
  let state: ContractState | null = null;
  if (options.resume !== undefined) {
    address = getAddress(options.resume);
    if (!(await isOurPolicy(client, address, build))) {
      throw new ArcDeployRefused(
        `${address} is not the Policy contract built from contracts/src/Policy.sol on this chain.`,
      );
    }
    state = await readContractState(client, address, build.abi);
    if (state.agent !== agent || state.executor !== executor) {
      throw new ArcDeployRefused(
        `${address} names agent ${state.agent} and executor ${state.executor}, not this env file's ${agent} and ${executor}: it is not this deployment.`,
      );
    }
    if (state.user !== deployer.address && state.user !== owner) {
      throw new ArcDeployRefused(
        `${address}'s user is ${state.user}, neither the deployer ${deployer.address} nor --owner ${owner}: only its user can change it.`,
      );
    }
  } else {
    const earlier = await earlierDeployment(client, deployer.address, build);
    if (earlier !== null && options.allowAnother !== true) {
      throw new ArcDeployRefused(
        `this key already deployed a Policy contract at ${earlier}: finish it with --resume ${earlier}, or pass --new to deploy another.`,
      );
    }
  }

  const needDeploy = address === null;
  const needRules =
    needDeploy || (state !== null && state.user === deployer.address && !sameRules(state.rules, rules));
  const needUser = needDeploy || (state !== null && state.user !== owner);
  if (state !== null && state.user === owner && !sameRules(state.rules, rules)) {
    say(
      `Note: the owner already holds ${address ?? ""} and its rules differ from the demo rules; they are the owner's to set.`,
    );
  }

  // ------------------------------------------------------------------ gas
  const fees = applyFeeFloor(
    await client.estimateFeesPerGas({ type: "eip1559", chain: null }),
    ARC_MIN_MAX_FEE_PER_GAS,
  );
  const deployData = encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [agent, executor] });
  let gas = 0n;
  if (needDeploy) gas += await client.estimateGas({ account: deployer, data: deployData });
  if (needRules) gas += SET_POLICY_GAS_BOUND;
  if (needUser) gas += SET_USER_GAS_BOUND;
  const need = (gas * fees.maxFeePerGas * HEADROOM_PERCENT) / 100n;
  const balance = await client.getBalance({ address: deployer.address });
  say(`Deployer (the executor's key): ${deployer.address}, holds ${usdc(balance)}`);
  say(`Agent ${agent}, executor ${executor}, owner ${owner}`);
  say(
    `To send: ${[needDeploy && "deploy", needRules && "setPolicy", needUser && "setUser"].filter(Boolean).join(", ") || "nothing"}` +
      (gas > 0n ? `; ${gas.toString()} gas at most ${usdc(need)} with headroom` : ""),
  );
  if (balance < need) {
    throw new ArcDeployRefused(
      `the deployer ${deployer.address} holds ${usdc(balance)}, less than the ${usdc(need)} the run needs: fund it at https://faucet.circle.com.`,
    );
  }

  // ------------------------------------------------------------------ send
  const sent: ArcDeployResult["sent"] = [];
  const confirm = async (step: ArcDeployResult["sent"][number]["step"], hash: Hex) => {
    sent.push({ step, hash });
    say(`${step.padEnd(9)} transaction ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${step} reverted in transaction ${hash}`);
    return receipt;
  };
  let deployBlock: bigint;
  if (needDeploy) {
    const receipt = await confirm("deploy", await wallet.sendTransaction({ data: deployData, ...fees }));
    if (!receipt.contractAddress) throw new Error("the deployment's receipt names no contract");
    address = getAddress(receipt.contractAddress);
    deployBlock = receipt.blockNumber;
    say(`Policy deployed at ${address} in block ${deployBlock.toString()}.`);
    say(`If this run stops now, finish it with --resume ${address}.`);
  } else {
    deployBlock = await findDeployBlock(client, address as Address);
  }
  const policy = address as Address;
  if (needRules) {
    await confirm(
      "setPolicy",
      await wallet.writeContract({
        address: policy,
        abi: build.abi,
        functionName: "setPolicy",
        args: [rules],
        ...fees,
      }),
    );
  }
  if (needUser) {
    await confirm(
      "setUser",
      await wallet.writeContract({
        address: policy,
        abi: build.abi,
        functionName: "setUser",
        args: [owner],
        ...fees,
      }),
    );
  }

  // ------------------------------------------------------------------ check
  const final = await readContractState(client, policy, build.abi);
  if (final.user !== owner || final.agent !== agent || final.executor !== executor) {
    throw new Error(
      `after the run ${policy} has user ${final.user}, agent ${final.agent}, executor ${final.executor}: not what was sent`,
    );
  }
  say(
    `Done: ${policy} (deploy block ${deployBlock.toString()}), user ${final.user}, ${sent.length === 0 ? "nothing was missing" : `${String(sent.length)} transaction(s) sent`}.`,
  );
  say("For the env file:");
  say(`POLICY_ADDRESS=${policy}`);
  say(`POLICY_DEPLOY_BLOCK=${deployBlock.toString()}`);
  return { address: policy, deployBlock, sent };
}
