/**
 * Node-only helpers (they read files and environment variables). Import from `@mandate/shared/node`
 * so that browser bundles of `@mandate/shared` never pull in `node:fs`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Account, type Address, type Chain } from "viem";
import { arcTestnet, devchain } from "./chains";
import { PolicyClient, type PolicyClientOptions } from "./client";
import { deploymentFileSchema, type DeploymentFile } from "./deployment";
import { addressSchema } from "./types";

export { clientKey, isPrivateAddress } from "./client-key";
export * from "./well-known-keys";

/**
 * A path relative to this file. Built with `node:path` rather than `new URL(relative, import.meta.url)`,
 * which bundlers (the dashboard's Turbopack build) read as an asset to copy into the build, while the
 * deployment file is written as the app runs. Bundled code has no reliable location of its own, so the
 * console passes `POLICY_DEPLOYMENT_FILE` instead of relying on this default.
 */
function besideThisFile(...segments: string[]): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), ...segments);
}

/** Where `npm run dev:chain` writes the local deployment, unless `POLICY_DEPLOYMENT_FILE` says otherwise. */
export const LOCAL_DEPLOYMENT_PATH = besideThisFile("..", "..", "devchain", "deployments", "local.json");

/** Environment variables to read: `process.env` or any plain map of them (tests pass their own). */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/**
 * The local deployment file to read and write: `POLICY_DEPLOYMENT_FILE` when set (tests that run their
 * own chain point every process at their own file), otherwise `LOCAL_DEPLOYMENT_PATH`.
 */
export function localDeploymentPath(env: EnvVars = process.env): string {
  return env.POLICY_DEPLOYMENT_FILE?.trim() || LOCAL_DEPLOYMENT_PATH;
}

export interface ResolvedDeployment {
  source: "env" | "devchain";
  address: Address;
  chain: Chain;
  rpcUrl: string;
  /** First block worth scanning for events, when known. */
  fromBlock: bigint | null;
  /** The local deployment file, when the source is the devchain. */
  local: DeploymentFile | null;
}

export class DeploymentNotFoundError extends Error {
  override name = "DeploymentNotFoundError";
}

/**
 * Finds the Policy contract to talk to:
 * 1. `POLICY_ADDRESS` (Arc testnet, RPC from `ARC_RPC_URL`, optional `POLICY_DEPLOY_BLOCK`), otherwise
 * 2. the local devchain deployment file written by `npm run dev:chain` (see `localDeploymentPath`).
 */
export function resolvePolicyDeployment(
  options: { env?: EnvVars; localPath?: string } = {},
): ResolvedDeployment {
  const env = options.env ?? process.env;
  const localPath = options.localPath ?? localDeploymentPath(env);

  const envAddress = env.POLICY_ADDRESS?.trim();
  if (envAddress) {
    const address = addressSchema.safeParse(envAddress);
    if (!address.success)
      throw new DeploymentNotFoundError(`POLICY_ADDRESS is not a valid address: ${envAddress}`);
    const deployBlock = env.POLICY_DEPLOY_BLOCK?.trim();
    if (deployBlock && !/^\d+$/.test(deployBlock)) {
      throw new DeploymentNotFoundError(`POLICY_DEPLOY_BLOCK must be a block number, got ${deployBlock}`);
    }
    const rpcUrl = env.ARC_RPC_URL?.trim() || arcTestnet.rpcUrls.default.http[0];
    return {
      source: "env",
      address: address.data,
      chain: arcTestnet,
      rpcUrl,
      fromBlock: deployBlock ? BigInt(deployBlock) : null,
      local: null,
    };
  }

  // Read at run time: `turbopackIgnore` keeps the console's bundler from tracing the whole project here.
  if (!existsSync(/* turbopackIgnore: true */ localPath)) {
    throw new DeploymentNotFoundError(
      `No Policy contract configured: set POLICY_ADDRESS, or run \`npm run dev:chain\` to create ${localPath}`,
    );
  }
  const local = deploymentFileSchema.parse(
    JSON.parse(readFileSync(/* turbopackIgnore: true */ localPath, "utf8")),
  );
  return {
    source: "devchain",
    address: local.address,
    chain: { ...devchain, id: local.chainId, rpcUrls: { default: { http: [local.rpcUrl] } } },
    rpcUrl: local.rpcUrl,
    fromBlock: BigInt(local.blockNumber),
    local,
  };
}

/** A `PolicyClient` for the resolved deployment. Pass `account` to enable the writes of that account's role. */
export function createPolicyClient(
  options: {
    account?: Account;
    deployment?: ResolvedDeployment;
  } & Pick<
    PolicyClientOptions,
    "capabilities" | "minMaxFeePerGas" | "receiptTimeoutMs" | "receiptPollingMs" | "maxLogBlockRange"
  > = {},
): PolicyClient {
  const { account, deployment = resolvePolicyDeployment(), ...rest } = options;
  const transport = http(deployment.rpcUrl);
  // Anvil mines instantly and Arc settles in under a second, so poll faster than viem's 4 s default.
  const pollingInterval = deployment.source === "devchain" ? 100 : 1_000;
  const publicClient = createPublicClient({ chain: deployment.chain, transport, pollingInterval });
  const base: PolicyClientOptions = { address: deployment.address, publicClient, ...rest };
  if (!account) return new PolicyClient(base);
  const walletClient = createWalletClient({ chain: deployment.chain, transport, account });
  return new PolicyClient({ ...base, walletClient });
}
