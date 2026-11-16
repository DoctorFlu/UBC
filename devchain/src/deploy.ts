import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  Category,
  categoryMask,
  devchain,
  deploymentFileSchema,
  PolicyClient,
  type DeploymentFile,
  type PolicyRules,
} from "@mandate/shared";
import { localDeploymentPath } from "@mandate/shared/node";
import { devAccount, type DevRole } from "./accounts";
import { DEVCHAIN_DIR, PRODUCTION_OUT_DIR } from "./foundry";

/**
 * Demo rules, chosen so demo trades land on both sides of every limit:
 * - $10 Crypto buy: approved.        $22 Crypto buy: waits for approval (over $20).
 * - $30 Crypto buy: over max trade.  Any Sports buy: category not allowed.
 * - Budget $200: about eight $25 buys. Daily loss $40: two losing $20 trades stop trading for the day.
 */
export const DEMO_POLICY: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

/**
 * Which Policy contract to deploy:
 * - `production`: `contracts/src/Policy.sol` compiled as is (base features only).
 * - `reference`: `devchain/contracts/PolicyReference.sol`, the same rules plus the requested extensions
 *   (`IntentProposed`, the `contextHash` overload of `proposeTrade`, and `previewTrade`).
 */
export const POLICY_CONTRACTS = ["production", "reference"] as const;
export type PolicyContractKind = (typeof POLICY_CONTRACTS)[number];

export function isPolicyContractKind(value: string): value is PolicyContractKind {
  return (POLICY_CONTRACTS as readonly string[]).includes(value);
}

export interface PolicyArtifact {
  abi: Abi;
  bytecode: Hex;
}

/** Reads the forge build output. Run `buildContracts()` first. */
export function loadPolicyArtifact(kind: PolicyContractKind): PolicyArtifact {
  const path =
    kind === "production"
      ? join(PRODUCTION_OUT_DIR, "Policy.sol", "Policy.json")
      : join(DEVCHAIN_DIR, "out", "PolicyReference.sol", "PolicyReference.json");
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Anvil mines instantly, so poll often instead of viem's 4 second default. */
const DEVCHAIN_POLLING_MS = 100;

function chainFor(rpcUrl: string) {
  return { ...devchain, rpcUrls: { default: { http: [rpcUrl] } } };
}

export interface Deployment {
  contract: PolicyContractKind;
  address: Address;
  blockNumber: bigint;
}

/** Deploys a Policy contract from `user` (the deployer becomes the contract's immutable `user`). */
export async function deployPolicy(options: {
  rpcUrl: string;
  contract: PolicyContractKind;
  user?: Account;
  agent?: Address;
  executor?: Address;
}): Promise<Deployment> {
  const user = options.user ?? devAccount("user");
  const chain = chainFor(options.rpcUrl);
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: DEVCHAIN_POLLING_MS });
  const wallet = createWalletClient({ chain, transport, account: user });
  const { abi, bytecode } = loadPolicyArtifact(options.contract);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [options.agent ?? devAccount("agent").address, options.executor ?? devAccount("executor").address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Policy (${options.contract}) deployment failed in transaction ${hash}`);
  }
  return {
    contract: options.contract,
    address: getAddress(receipt.contractAddress),
    blockNumber: receipt.blockNumber,
  };
}

/** A `PolicyClient` acting as one of the devchain roles. */
export function devPolicyClient(rpcUrl: string, address: Address, role: DevRole): PolicyClient {
  const chain = chainFor(rpcUrl);
  const transport = http(rpcUrl);
  return new PolicyClient({
    address,
    publicClient: createPublicClient({ chain, transport, pollingInterval: DEVCHAIN_POLLING_MS }),
    walletClient: createWalletClient({ chain, transport, account: devAccount(role) }),
  });
}

/**
 * Writes the deployment file other packages read through `resolvePolicyDeployment()`. The file is written
 * beside its final name and renamed into place, so a process that reads it while it is being replaced
 * (the console polls it) sees the old record or the new one, never half of one.
 */
export function writeDeploymentFile(
  file: DeploymentFile,
  path: string = localDeploymentPath(),
): DeploymentFile {
  const valid = deploymentFileSchema.parse(file);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`);
  renameSync(temp, path);
  return valid;
}

/** Builds the deployment record for the devchain roles. */
export function deploymentRecord(rpcUrl: string, deployment: Deployment): DeploymentFile {
  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    contract: deployment.contract,
    rpcUrl,
    address: deployment.address,
    blockNumber: Number(deployment.blockNumber),
    user: devAccount("user").address,
    agent: devAccount("agent").address,
    executor: devAccount("executor").address,
    deployedAt: new Date().toISOString(),
  };
}
