import { isDevchainRpc, resolvePolicyDeployment } from "@mandate/shared/node";
import { ConfigError, DEVCHAIN_DEPLOYMENT } from "./config";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Lets the MCP server follow a devchain deployment file, the way the console and the simulated executor do.
 *
 * Only when `POLICY_DEPLOYMENT_FILE` is set and `POLICY_ADDRESS` is not: the file's contract address,
 * deploy block and RPC replace `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and `ARC_RPC_URL`. The RPC comes
 * from the file even when `ARC_RPC_URL` is set, because the contract the file records lives only on the
 * chain the file names. The hosted demo chain needs this: its contract address is known only once the
 * chain has started, so it cannot be written into the environment beforehand.
 *
 * Returns the environment unchanged otherwise, and throws a `ConfigError` naming the variable (and the
 * path, which is not a secret) when the file is missing or invalid.
 */
export function applyDeploymentFile(env: Env): Env {
  const file = env.POLICY_DEPLOYMENT_FILE?.trim();
  if (!file || env.POLICY_ADDRESS?.trim()) return env;
  let deployment;
  try {
    deployment = resolvePolicyDeployment({ env: {}, localPath: file });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError([`POLICY_DEPLOYMENT_FILE: ${file} is not a usable deployment file (${detail})`]);
  }
  return {
    ...env,
    // A devchain's file: anvil's published keys may sign on it (see `parseConfig`).
    [DEVCHAIN_DEPLOYMENT]: isDevchainRpc(deployment.rpcUrl),
    POLICY_ADDRESS: deployment.address,
    POLICY_DEPLOY_BLOCK: String(deployment.fromBlock ?? 0n),
    ARC_RPC_URL: deployment.rpcUrl,
  };
}
