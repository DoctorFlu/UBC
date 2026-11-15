import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  type Policy,
} from "@mandate/shared";
import { LOCAL_DEPLOYMENT_PATH } from "@mandate/shared/node";
import { devAccount, type DevRole } from "./accounts";
import { DEVCHAIN_DIR } from "./foundry";

/**
 * Demo policy, chosen so demo trades land on both sides of every limit:
 * - $10 Crypto buy: approved.        $22 Crypto buy: waits for approval (over $20).
 * - $30 Crypto buy: over max trade.  Any Sports buy: category not allowed.
 * - Budget $200: about eight $25 buys. Daily loss $40: two losing $20 trades stop trading for the day.
 */
export const DEMO_POLICY: Policy = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

export interface PolicyArtifact {
  abi: Abi;
  bytecode: Hex;
}

/** Reads the forge build output. Run `buildContracts()` first. */
export function loadPolicyArtifact(): PolicyArtifact {
  const path = join(DEVCHAIN_DIR, "out", "PolicyReference.sol", "PolicyReference.json");
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Anvil mines instantly, so poll often instead of viem's 4 second default. */
const DEVCHAIN_POLLING_MS = 100;

function chainFor(rpcUrl: string) {
  return { ...devchain, rpcUrls: { default: { http: [rpcUrl] } } };
}

export interface Deployment {
  address: Address;
  blockNumber: bigint;
}

/** Deploys PolicyReference from `owner` with the given agent and executor. */
export async function deployPolicy(options: {
  rpcUrl: string;
  owner?: Account;
  agent?: Address;
  executor?: Address;
}): Promise<Deployment> {
  const owner = options.owner ?? devAccount("owner");
  const chain = chainFor(options.rpcUrl);
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: DEVCHAIN_POLLING_MS });
  const wallet = createWalletClient({ chain, transport, account: owner });
  const { abi, bytecode } = loadPolicyArtifact();
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [options.agent ?? devAccount("agent").address, options.executor ?? devAccount("executor").address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`PolicyReference deployment failed in transaction ${hash}`);
  }
  return { address: getAddress(receipt.contractAddress), blockNumber: receipt.blockNumber };
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

/** Writes the deployment file other packages read through `resolvePolicyDeployment()`. */
export function writeDeploymentFile(
  file: DeploymentFile,
  path: string = LOCAL_DEPLOYMENT_PATH,
): DeploymentFile {
  const valid = deploymentFileSchema.parse(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(valid, null, 2)}\n`);
  return valid;
}

/** Builds the deployment record for the devchain roles. */
export function deploymentRecord(rpcUrl: string, deployment: Deployment): DeploymentFile {
  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrl,
    address: deployment.address,
    blockNumber: Number(deployment.blockNumber),
    owner: devAccount("owner").address,
    agent: devAccount("agent").address,
    executor: devAccount("executor").address,
    deployedAt: new Date().toISOString(),
  };
}
