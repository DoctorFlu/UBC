import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentFileSchema,
  devchain,
  type DeploymentFile,
  type PolicyRules,
} from "@mandate/shared";
import {
  DEMO_POLICY,
  deployPolicy,
  deploymentRecord,
  devPolicyClient,
  writeDeploymentFile,
  type PolicyContractKind,
} from "./deploy";

export interface EnsureDeploymentOptions {
  /** The chain, as every other process reaches it. It is written into the deployment file. */
  rpcUrl: string;
  contract: PolicyContractKind;
  /** The deployment file to reuse and (re)write. */
  path: string;
  /** Rules for a fresh deployment. Defaults to `DEMO_POLICY`. */
  rules?: PolicyRules;
}

export type EnsureDeploymentResult =
  | { action: "reused"; record: DeploymentFile }
  | { action: "deployed"; record: DeploymentFile; reason: string };

/**
 * Deploy once, for a devchain that outlives a single run (the hosted demo chain in `deploy/`, whose anvil
 * keeps its state in a volume). It reuses the deployment the file describes while that contract is still
 * on the chain, so the console's history and the owner's rules survive a restart. Otherwise (no file yet,
 * a file for another chain or contract, or a chain whose state was lost) it deploys a fresh contract with
 * the given rules and rewrites the file. The console and the MCP server treat a fresh deployment as a new
 * session, so nothing stale is shown.
 */
export async function ensureDeployment(options: EnsureDeploymentOptions): Promise<EnsureDeploymentResult> {
  const { rpcUrl, contract, path } = options;
  const chain = { ...devchain, rpcUrls: { default: { http: [rpcUrl] } } };
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `the chain at ${rpcUrl} has chain id ${String(chainId)}, not Arc's ${String(ARC_TESTNET_CHAIN_ID)}; ` +
        `start anvil with --chain-id ${String(ARC_TESTNET_CHAIN_ID)}`,
    );
  }

  const existing = readDeploymentFile(path);
  let reason: string;
  if (existing === null) {
    reason = "there is no deployment file yet";
  } else if (existing === "unreadable") {
    reason = "the deployment file could not be read";
  } else if (existing.rpcUrl !== rpcUrl || existing.chainId !== chainId) {
    reason = "the deployment file describes another chain";
  } else if (existing.contract !== contract) {
    reason = `the deployment file holds the ${existing.contract} contract, not the ${contract} one`;
  } else if ((await client.getCode({ address: existing.address })) === undefined) {
    reason = `the chain has no contract at ${existing.address}, so its state was reset`;
  } else {
    return { action: "reused", record: existing };
  }

  const deployment = await deployPolicy({ rpcUrl, contract });
  await devPolicyClient(rpcUrl, deployment.address, "user").setPolicy(options.rules ?? DEMO_POLICY);
  const record = writeDeploymentFile(deploymentRecord(rpcUrl, deployment), path);
  return { action: "deployed", record, reason };
}

/** The deployment file's record, null when there is no file, or "unreadable" when it is not one. */
function readDeploymentFile(path: string): DeploymentFile | "unreadable" | null {
  if (!existsSync(path)) return null;
  try {
    return deploymentFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return "unreadable";
  }
}
