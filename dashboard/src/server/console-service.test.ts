import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_POLICY } from "@mandate/devchain";
import { Category, policyBaseAbi, rulesToChain } from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConsoleSnapshot } from "@/lib/live/types";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../test/support/devchain";
import type { ConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";

const silent = { info: () => undefined, warn: () => undefined };

function config(dataDir: string): ConsoleConfig {
  return {
    dataDir,
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: null,
    streamSecurityToken: null,
    publicUrl: "http://localhost:3000",
    mcpPublicUrl: null,
  };
}

function startService(chain: TestChain, dataDir: string): ConsoleService {
  const service = new ConsoleService(config(dataDir), openDatabase(dataDir), {
    env: chain.env,
    logger: silent,
  });
  service.start();
  return service;
}

/** Waits until the console has read every block up to the chain's current head. */
async function caughtUp(service: ConsoleService, chain: TestChain): Promise<ConsoleSnapshot> {
  const head = Number(await chain.user.publicClient.getBlockNumber({ cacheTime: 0 }));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snapshot = service.snapshot();
    if (snapshot.feed.health === "live" && (snapshot.feed.syncedBlock ?? -1) >= head) {
      const missing = snapshot.chain?.intents.some((intent) => intent.market === null);
      if (!missing) return snapshot;
    }
    if (Date.now() > deadline) throw new Error(`console did not catch up: ${JSON.stringify(snapshot.feed)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The parts of a snapshot that must be identical however the state was built. */
function chainState(snapshot: ConsoleSnapshot) {
  const chain = snapshot.chain;
  if (!chain) throw new Error("no chain view");
  const { head: _head, lossTodayCents: _loss, ...rest } = chain;
  return rest;
}

const trade = { category: Category.Crypto, outcome: "YES" as const, isBuy: true, limitPrice: 65 };

describe("ConsoleService against the production contract", () => {
  let chain: TestChain;
  let dataDir: string;
  let service: ConsoleService;

  beforeAll(async () => {
    chain = await startTestChain({ contract: "production" });
    dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    service = startService(chain, dataDir);
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("rebuilds rules, intents and totals from the contract's events", async () => {
    const approved = await chain.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_000 });
    const held = await chain.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 2_200 });
    const tooBig = await chain.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 3_000 });
    const sports = await chain.agent.proposeTrade({
      ...trade,
      market: "GEMI-NBA2611161900-LAL",
      category: Category.Sports,
      amountCents: 500,
    });
    await chain.user.approveIntent(held.intentId);
    await chain.executor.recordResult({
      intentId: approved.intentId,
      filled: true,
      filledCents: 1_000,
      pnlCents: 0,
    });
    await chain.executor.recordResult({
      intentId: held.intentId,
      filled: false,
      filledCents: 0,
      pnlCents: 0,
    });

    const snapshot = await caughtUp(service, chain);
    const view = snapshot.chain;
    if (!view) throw new Error("no chain view");
    const contractState = await chain.user.getSnapshot();

    expect(view.rules).toEqual(contractState.rules);
    expect(view.committedCents).toBe(contractState.committedCents);
    expect(view.policyVersion).toBe(1);
    expect(snapshot.contract?.roles?.user).toBe(chain.user.account?.address);
    expect(snapshot.contract?.kind).toBe("production");
    expect(snapshot.contract?.recordsContextHash).toBe(false);

    const byId = new Map(view.intents.map((intent) => [intent.id, intent]));
    expect(byId.get(approved.intentId)).toMatchObject({ status: "executed", filledCents: 1_000 });
    expect(byId.get(held.intentId)).toMatchObject({ status: "failed", amountCents: 2_200 });
    // No event carries a rejected proposal's details on the production contract: getIntent filled them.
    expect(byId.get(tooBig.intentId)).toMatchObject({
      status: "rejected",
      reason: "over max trade size",
      market: BTC_ABOVE_65K,
      amountCents: 3_000,
      category: Category.Crypto,
    });
    expect(byId.get(sports.intentId)).toMatchObject({
      reason: "category not allowed",
      category: Category.Sports,
    });
  });

  it("rebuilds the identical state after a restart, from its store or from the chain alone", async () => {
    const before = chainState(await caughtUp(service, chain));
    await service.stop();

    const resumed = startService(chain, dataDir);
    const fresh = startService(chain, mkdtempSync(join(tmpdir(), "mandate-console-")));
    try {
      expect(chainState(await caughtUp(resumed, chain))).toEqual(before);
      expect(chainState(await caughtUp(fresh, chain))).toEqual(before);
    } finally {
      await resumed.stop();
      await fresh.stop();
    }
    service = startService(chain, dataDir);
  });

  it("follows new events and the pause switch as they land", async () => {
    await caughtUp(service, chain);
    await chain.user.setPaused(true);
    const paused = await chain.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 500 });
    const snapshot = await caughtUp(service, chain);
    expect(snapshot.chain?.paused).toBe(true);
    expect(snapshot.chain?.intents.find((intent) => intent.id === paused.intentId)).toMatchObject({
      status: "rejected",
      reason: "agent paused",
    });
    await chain.user.setPaused(false);
    expect((await caughtUp(service, chain)).chain?.paused).toBe(false);
  });
});

describe("ConsoleService when the deployment changes", () => {
  it("reports an unconfigured console, then follows a chain that starts later, then a restarted one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-chain-"));
    const env = { POLICY_DEPLOYMENT_FILE: join(dir, "deployment.json") };
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    const service = new ConsoleService(config(dataDir), openDatabase(dataDir), { env, logger: silent });
    service.start();
    let first: TestChain | undefined;
    let second: TestChain | undefined;
    try {
      await expect.poll(() => service.snapshot().feed.health).toBe("unconfigured");
      expect(service.snapshot().contract).toBeNull();

      first = await startTestChain({ dir });
      await first.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 1_000 });
      const one = await caughtUp(service, first);
      expect(one.chain?.intents).toHaveLength(1);

      // A restarted devchain deploys to the same address with a different history.
      await first.stop();
      second = await startTestChain({ dir });
      expect(second.address).toBe(first.address);
      await expect
        .poll(async () => (await caughtUp(service, second as TestChain)).chain?.intents.length, {
          timeout: 20_000,
        })
        .toBe(0);
    } finally {
      await service.stop();
      await second?.stop();
    }
  }, 60_000);
});

describe("ConsoleService with onchain values offchain code cannot hold", () => {
  it("keeps reading past them: intents are kept and flagged, an undecodable rules event is skipped and reported", async () => {
    const chain = await startTestChain({ contract: "production" });
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    const service = startService(chain, dataDir);
    const max = 2n ** 256n - 1n;
    const write = async (client: TestChain["agent"], call: { functionName: string; args: unknown[] }) => {
      const wallet = client.walletClient;
      if (!wallet) throw new Error("no wallet");
      const hash = await wallet.writeContract({
        address: chain.address,
        abi: policyBaseAbi,
        account: wallet.account,
        chain: wallet.chain,
        ...call,
      } as never);
      await client.publicClient.waitForTransactionReceipt({ hash });
    };
    try {
      await caughtUp(service, chain);
      // With a stolen agent key: a sell at limit 2^256 - 1 (approved) and a buy of 2^256 - 1 cents (rejected).
      const sellId = await chain.agent.getIntentCount();
      await write(chain.agent, {
        functionName: "proposeTrade",
        args: [BTC_ABOVE_65K, Category.Crypto, "NO", false, 100n, max],
      });
      await write(chain.agent, {
        functionName: "proposeTrade",
        args: [BTC_ABOVE_65K, Category.Crypto, "NO", true, max, 31n],
      });
      const flagged = await caughtUp(service, chain);
      expect(flagged.chain?.intents.find((intent) => intent.id === sellId)).toMatchObject({
        status: "approved",
        limitPrice: null,
        outOfRange: { limitPrice: max.toString() },
      });
      expect(flagged.chain?.intents.find((intent) => intent.id === sellId + 1)).toMatchObject({
        status: "rejected",
        amountCents: null,
        outOfRange: { amountCents: max.toString() },
      });

      // Rules only the owner sets: such an event cannot be represented, so it is skipped and said, and the
      // scanner still moves on to the next proposal.
      await write(chain.user, {
        functionName: "setPolicy",
        args: [{ ...rulesToChain(DEMO_POLICY), budgetCents: max }],
      });
      const next = await chain.agent.proposeTrade({ ...trade, market: BTC_ABOVE_65K, amountCents: 500 });
      await expect
        .poll(() => service.snapshot().chain?.intents.some((intent) => intent.id === next.intentId), {
          timeout: 15_000,
        })
        .toBe(true);
      await expect.poll(() => service.snapshot().feed.health).toBe("lagging");
      expect(service.snapshot().feed.detail).toContain("1 Policy event");
    } finally {
      await service.stop();
      await chain.stop();
    }
  }, 60_000);
});
