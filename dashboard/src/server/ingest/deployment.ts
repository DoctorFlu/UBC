import "server-only";

import { statSync } from "node:fs";

import { ARC_TESTNET, DEVCHAIN_RPC_URL, arcTestnet, chainExplorerBaseUrl } from "@mandate/shared";
import {
  DeploymentNotFoundError,
  type EnvVars,
  type ResolvedDeployment,
  localDeploymentPath,
  resolvePolicyDeployment,
} from "@mandate/shared/node";

import type { ConsoleNetwork, ContractKind } from "@/lib/live/types";

export type DeploymentResolution =
  | {
      ok: true;
      deployment: ResolvedDeployment;
      network: ConsoleNetwork;
      kind: ContractKind | null;
      fileStamp: number | null;
    }
  | { ok: false; network: ConsoleNetwork; detail: string; fileStamp: number | null };

/** The network the browser uses before any deployment is known: the local devchain's defaults. */
export const UNCONFIGURED_NETWORK: ConsoleNetwork = {
  kind: "local",
  chainId: ARC_TESTNET.chainId,
  name: "Local dev chain",
  rpcUrl: DEVCHAIN_RPC_URL,
  explorerUrl: null,
};

/** Modification time of the local deployment file, or null when it does not exist. */
export function deploymentFileStamp(env: EnvVars = process.env): number | null {
  try {
    return statSync(localDeploymentPath(env)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * `CONSOLE_BROWSER_RPC_URL`: where the browser reaches the local devchain when that is not the address the
 * deployment file records. On a laptop the browser uses the same loopback RPC as the server; on a host the
 * server reaches anvil on a private network, and the browser goes through the console's reverse proxy.
 * Throws on a value that is not an http(s) URL, so a typo is reported instead of breaking the wallet.
 */
function browserRpcUrl(env: EnvVars): string | null {
  const value = env.CONSOLE_BROWSER_RPC_URL?.trim();
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error("CONSOLE_BROWSER_RPC_URL must be an http(s) URL");
  }
  return value;
}

/**
 * Which Policy contract the console reads, by the same rules every package uses
 * (`resolvePolicyDeployment`): `POLICY_ADDRESS` means Arc testnet, otherwise the devchain's deployment
 * file. The browser gets Arc's public RPC, never `ARC_RPC_URL`, which may carry a provider key.
 */
export function resolveDeployment(env: EnvVars = process.env): DeploymentResolution {
  const fileStamp = env.POLICY_ADDRESS?.trim() ? null : deploymentFileStamp(env);
  try {
    const deployment = resolvePolicyDeployment({ env });
    if (deployment.source === "env") {
      return {
        ok: true,
        deployment,
        kind: null,
        fileStamp,
        network: {
          kind: "arc-testnet",
          chainId: arcTestnet.id,
          name: "Arc testnet",
          rpcUrl: ARC_TESTNET.rpcUrl,
          explorerUrl: chainExplorerBaseUrl(arcTestnet),
        },
      };
    }
    return {
      ok: true,
      deployment,
      kind: deployment.local?.contract ?? null,
      fileStamp,
      network: {
        kind: "local",
        chainId: deployment.chain.id,
        name: "Local dev chain",
        rpcUrl: browserRpcUrl(env) ?? deployment.rpcUrl,
        explorerUrl: null,
      },
    };
  } catch (error) {
    if (error instanceof DeploymentNotFoundError) {
      return {
        ok: false,
        network: UNCONFIGURED_NETWORK,
        fileStamp,
        detail: env.POLICY_ADDRESS?.trim()
          ? error.message
          : "No Policy contract is configured. Start the local chain with `npm run dev:chain`, or set POLICY_ADDRESS.",
      };
    }
    return {
      ok: false,
      network: UNCONFIGURED_NETWORK,
      fileStamp,
      detail: `The Policy deployment could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
