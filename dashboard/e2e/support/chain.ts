/**
 * The local chain behind the end-to-end tests: a Policy contract on anvil, its deployment file, and the
 * devchain role clients. Test-only; it uses anvil's public keys.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AnvilInstance,
  DEMO_POLICY,
  type PolicyContractKind,
  buildContracts,
  deployPolicy,
  deploymentRecord,
  devAccount,
  devPolicyClient,
  startAnvil,
  writeDeploymentFile,
} from "@mandate/devchain";
import { Category, type PolicyClient, type TradeIntentInput, policyAbi } from "@mandate/shared";
import { type Address, createPublicClient, createWalletClient, encodeFunctionData, http } from "viem";

export const DASHBOARD_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Everything one suite writes: the deployment file and the console's data directory. Git-ignored. */
export function suiteDir(suite: string): string {
  return join(DASHBOARD_DIR, ".data", `e2e-${suite}`);
}

export function suitePaths(suite: string) {
  const dir = suiteDir(suite);
  return { dir, deploymentFile: join(dir, "deployment.json"), dataDir: join(dir, "console") };
}

/**
 * Clears the previous run's files. The chain is new on every run but deploys to the same address, so an
 * old event store would describe a chain that no longer exists.
 */
export function freshSuiteDir(suite: string): ReturnType<typeof suitePaths> {
  const paths = suitePaths(suite);
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}

export interface TestChain {
  anvil: AnvilInstance;
  address: Address;
  user: PolicyClient;
  agent: PolicyClient;
  executor: PolicyClient;
}

export async function startTestChain(options: {
  port: number;
  deploymentFile: string;
  contract?: PolicyContractKind;
}): Promise<TestChain> {
  buildContracts();
  const anvil = await startAnvil({ port: options.port });
  const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract: options.contract ?? "production" });
  writeDeploymentFile(deploymentRecord(anvil.rpcUrl, deployment), options.deploymentFile);
  const client = (role: "user" | "agent" | "executor") =>
    devPolicyClient(anvil.rpcUrl, deployment.address, role);
  return {
    anvil,
    address: deployment.address,
    user: client("user"),
    agent: client("agent"),
    executor: client("executor"),
  };
}

export const BTC_65K = "GEMI-BTC2611202200-HI65000";
export const BTC_64K = "GEMI-BTC2611202200-HI64000";
export const BTC_63K = "GEMI-BTC2611202200-HI63000";
export const ETH_2800 = "GEMI-ETH2611202200-HI2800";

/** A NO buy on a Gemini market, the shape the hedge agent proposes. */
export function noBuy(
  market: string,
  amountCents: number,
  limitPrice: number,
  category: number = Category.Crypto,
) {
  return {
    market,
    category,
    outcome: "NO",
    isBuy: true,
    amountCents,
    limitPrice,
  } satisfies TradeIntentInput;
}

/**
 * The demo history the smoke test and the screenshots read: the demo mandate, then every verdict the
 * contract gives, with one intent still waiting for the owner. Ids start at 0.
 */
export async function seedDemo(chain: TestChain): Promise<void> {
  const { user, agent, executor } = chain;
  await user.setPolicy(DEMO_POLICY);
  // 0: approved and filled.
  await agent.proposeTrade(noBuy(BTC_65K, 1_240, 31));
  await executor.recordResult({ intentId: 0, filled: true, filledCents: 1_240, pnlCents: 0 });
  // 1: approved, did not fill.
  await agent.proposeTrade(noBuy(ETH_2800, 450, 9));
  await executor.recordResult({ intentId: 1, filled: false, filledCents: 0, pnlCents: 0 });
  // 2: above the approval threshold, approved by the owner, filled at a small loss.
  await agent.proposeTrade(noBuy(BTC_64K, 2_160, 27));
  await user.approveIntent(2);
  await executor.recordResult({ intentId: 2, filled: true, filledCents: 2_160, pnlCents: -180 });
  // 3: held, then rejected by the owner.
  await agent.proposeTrade(noBuy(BTC_63K, 2_300, 23));
  await user.rejectIntent(3);
  // 4 and 5: rejected at proposal.
  await agent.proposeTrade(noBuy(BTC_64K, 3_100, 31));
  await agent.proposeTrade(noBuy("GEMI-NBA2611200100-HILAL", 1_560, 52, Category.Sports));
  // 6: waiting for the owner.
  await agent.proposeTrade(noBuy(BTC_63K, 2_400, 24));
}

/**
 * Proposes straight to the contract with the agent's key, past the client's input checks, as a hostile
 * agent (or the red team) can: the contract accepts any market string, so the console must too.
 */
export async function proposeRaw(chain: TestChain, market: string, amountCents: number): Promise<void> {
  const transport = http(chain.anvil.rpcUrl);
  const wallet = createWalletClient({ account: devAccount("agent"), transport });
  const hash = await wallet.sendTransaction({
    chain: null,
    to: chain.address,
    data: encodeFunctionData({
      abi: policyAbi,
      functionName: "proposeTrade",
      args: [market, Category.Crypto, "NO", true, BigInt(amountCents), 31n],
    }),
    gas: 25_000_000n,
  });
  const receipt = await createPublicClient({ transport }).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("the hostile proposal reverted");
}
