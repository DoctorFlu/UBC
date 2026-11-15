import { createPublicClient, createTestClient, http, type Address } from "viem";
import { devchain, type PolicyClient } from "@mandate/shared";
import { deployPolicy, devPolicyClient, startAnvil, type AnvilInstance } from "../src";

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
  address: Address;
  deployBlock: bigint;
  owner: PolicyClient;
  agent: PolicyClient;
  executor: PolicyClient;
  outsider: PolicyClient;
}

/** Deploys a fresh PolicyReference and returns a client per role (outsider has no role). */
export async function deployTestPolicy(anvil: TestAnvil): Promise<TestPolicy> {
  const deployment = await deployPolicy({ rpcUrl: anvil.rpcUrl });
  const client = (role: "owner" | "agent" | "executor" | "outsider") =>
    devPolicyClient(anvil.rpcUrl, deployment.address, role);
  return {
    address: deployment.address,
    deployBlock: deployment.blockNumber,
    owner: client("owner"),
    agent: client("agent"),
    executor: client("executor"),
    outsider: client("outsider"),
  };
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
