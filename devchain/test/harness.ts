import { createPublicClient, createTestClient, http, type Address } from "viem";
import {
  devchain,
  intentsMissingDetails,
  listIntents,
  mergeIntentDetails,
  policyBaseAbi,
  type PolicyClient,
  type PolicyViewState,
} from "@mandate/shared";
import {
  deployPolicy,
  devPolicyClient,
  startAnvil,
  type AnvilInstance,
  type DevRole,
  type PolicyContractKind,
} from "../src";

/** Noon UTC, so a test run never straddles a UTC day boundary by accident. */
export const GENESIS_TIMESTAMP = Date.UTC(2026, 10, 16, 12, 0, 0) / 1000;

export interface TestAnvil {
  instance: AnvilInstance;
  rpcUrl: string;
  /** Moves chain time forward and mines a block. */
  advanceTime: (seconds: number) => Promise<void>;
  latestTimestamp: () => Promise<number>;
  stop: () => Promise<void>;
}

/** Anvil on a free port with a fixed genesis time. */
export async function startTestAnvil(): Promise<TestAnvil> {
  const instance = await startAnvil({ port: 0, timestamp: GENESIS_TIMESTAMP });
  const chain = { ...devchain, rpcUrls: { default: { http: [instance.rpcUrl] } } };
  const transport = http(instance.rpcUrl);
  const testClient = createTestClient({ mode: "anvil", chain, transport });
  const publicClient = createPublicClient({ chain, transport });
  return {
    instance,
    rpcUrl: instance.rpcUrl,
    advanceTime: async (seconds) => {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    latestTimestamp: async () => Number((await publicClient.getBlock()).timestamp),
    stop: instance.stop,
  };
}

export interface TestPolicy {
  contract: PolicyContractKind;
  address: Address;
  deployBlock: bigint;
  user: PolicyClient;
  agent: PolicyClient;
  executor: PolicyClient;
  outsider: PolicyClient;
}

/** Deploys a fresh Policy contract of the given kind and returns a client per role (outsider has no role). */
export async function deployTestPolicy(anvil: TestAnvil, contract: PolicyContractKind): Promise<TestPolicy> {
  const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl, contract });
  const client = (role: DevRole) => devPolicyClient(anvil.rpcUrl, deployment.address, role);
  return {
    contract,
    address: deployment.address,
    deployBlock: deployment.blockNumber,
    user: client("user"),
    agent: client("agent"),
    executor: client("executor"),
    outsider: client("outsider"),
  };
}

/**
 * Intents as the event reducer sees them, completed the way production code must: details the log did
 * not carry (no `IntentProposed` on the production contract) are filled from `getIntent`. The result has
 * the same shape as `PolicyClient.getIntents()`, so the two can be compared directly.
 */
export async function intentsFromEvents(
  state: PolicyViewState,
  reader: PolicyClient,
): Promise<Record<string, unknown>[]> {
  const stored = new Map((await reader.getIntents(intentsMissingDetails(state))).map((i) => [i.id, i]));
  return listIntents(state).map((view) => {
    const fromChain = stored.get(view.id);
    const v = fromChain ? mergeIntentDetails(view, fromChain) : view;
    return {
      id: v.id,
      market: v.market,
      category: v.category,
      outcome: v.outcome,
      isBuy: v.isBuy,
      amountCents: v.amountCents,
      limitPrice: v.limitPrice,
      status: v.status,
      proposedAt: v.proposedAt,
      // The contract stores zeros until a result is recorded; the reducer uses null for "no result yet".
      filledCents: v.filledCents ?? 0,
      pnlCents: v.pnlCents ?? 0,
    };
  });
}

/** Small deterministic PRNG (mulberry32) so failures reproduce from the seed. */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const chance = (p: number): boolean => next() < p;
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  return { next, int, chance, pick };
}

/** A proposal with any values the ABI can carry, as a stolen agent key would send it. */
export interface RawProposal {
  market: string;
  category: number;
  outcome: string;
  isBuy: boolean;
  amountCents: bigint;
  limitPrice: bigint;
}

/**
 * Sends `proposeTrade` with the agent's key and no offchain validation, the way an attacker holding the
 * key would. `PolicyClient.proposeTrade` refuses such values before sending, so it cannot be used here.
 * Returns the new intent's id.
 */
export async function proposeRaw(agent: PolicyClient, p: RawProposal): Promise<number> {
  const wallet = agent.walletClient;
  if (!wallet) throw new Error("the agent client has no wallet");
  const id = await agent.getIntentCount();
  const hash = await wallet.writeContract({
    address: agent.address,
    abi: policyBaseAbi,
    functionName: "proposeTrade",
    args: [p.market, p.category, p.outcome, p.isBuy, p.amountCents, p.limitPrice],
    account: wallet.account,
    chain: wallet.chain,
  });
  const receipt = await agent.publicClient.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== "success") throw new Error(`proposeTrade ${hash} reverted`);
  return id;
}
