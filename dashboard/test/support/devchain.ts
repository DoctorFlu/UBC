/**
 * A private local chain for tests: anvil on a free port, a freshly deployed Policy contract, and a
 * deployment file in a temporary folder. Point the console at it with `env` (it sets
 * POLICY_DEPLOYMENT_FILE), so nothing touches devchain/deployments/local.json or port 8545.
 *
 * Uses anvil's public test accounts: development only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AnvilInstance,
  type PolicyContractKind,
  DEMO_POLICY,
  deployPolicy,
  deploymentRecord,
  devPolicyClient,
  startAnvil,
  writeDeploymentFile,
} from "@mandate/devchain";
import type { PolicyClient, PolicyRules } from "@mandate/shared";
import type { Address } from "viem";

export interface TestChain {
  rpcUrl: string;
  port: number;
  address: Address;
  deployBlock: bigint;
  deploymentFile: string;
  /** Environment that points the console and the dev scripts at this chain. */
  env: { POLICY_DEPLOYMENT_FILE: string };
  user: PolicyClient;
  agent: PolicyClient;
  executor: PolicyClient;
  outsider: PolicyClient;
  anvil: AnvilInstance;
  stop: () => Promise<void>;
}

export interface TestChainOptions {
  contract?: PolicyContractKind;
  /** Rules set right after deployment, or null to leave the contract without a policy. */
  policy?: PolicyRules | null;
  /** Folder for the deployment file; a fresh temporary folder by default. */
  dir?: string;
  port?: number;
}

export async function startTestChain(options: TestChainOptions = {}): Promise<TestChain> {
  const contract = options.contract ?? "production";
  const anvil = await startAnvil({ port: options.port ?? 0 });
  try {
    const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract });
    const client = (role: "user" | "agent" | "executor" | "outsider") =>
      devPolicyClient(anvil.rpcUrl, deployment.address, role);
    const user = client("user");
    const policy = options.policy === undefined ? DEMO_POLICY : options.policy;
    if (policy) await user.setPolicy(policy);
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), "mandate-chain-"));
    const deploymentFile = join(dir, "deployment.json");
    writeDeploymentFile(deploymentRecord(anvil.rpcUrl, deployment), deploymentFile);
    return {
      rpcUrl: anvil.rpcUrl,
      port: anvil.port,
      address: deployment.address,
      deployBlock: deployment.blockNumber,
      deploymentFile,
      env: { POLICY_DEPLOYMENT_FILE: deploymentFile },
      user,
      agent: client("agent"),
      executor: client("executor"),
      outsider: client("outsider"),
      anvil,
      stop: anvil.stop,
    };
  } catch (error) {
    await anvil.stop();
    throw error;
  }
}

/** A Gemini instrument symbol in the shape the agent proposes. */
export const BTC_ABOVE_65K = "GEMI-BTC2611202200-HI65000";
export const BTC_ABOVE_66K = "GEMI-BTC2611202200-HI66000";
