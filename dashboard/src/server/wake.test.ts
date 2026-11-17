import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ladder } from "@mandate/gemini";
import { Category, WakeTarget, type WakeEvent, wakeEventSchema } from "@mandate/shared";
import { createTestClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordedLadder, recordedPlanRequest } from "../../e2e/support/fake-gemini";
import { envMandate, envSnapshot, signUpWorkspace, workspaceAgent } from "../../test/support/accounts";
import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../test/support/devchain";
import { type ConsoleConfig, readWakeConfig, testConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";
import { NO_WAKE_TARGET_REASON } from "./wake";

const silent = { info: () => undefined, warn: () => undefined };
const SECRET_URL = "https://hooks.example.test/routines/secret-path-7/run";
const KEY = "routine-key-for-tests";

function config(dataDir: string): ConsoleConfig {
  return testConsoleConfig(dataDir, {
    publicUrl: "http://localhost:3000",
    wake: {
      target: new WakeTarget(SECRET_URL, KEY),
      offReason: null,
      dailyCap: 6,
      priceCheckMs: 50,
      testClock: false,
    },
  });
}

/** A webhook that answers 200 and keeps every body it was sent. */
function receiver() {
  const bodies: WakeEvent[] = [];
  const fetch = (url: string, init: RequestInit) => {
    expect(url).toBe(SECRET_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    bodies.push(wakeEventSchema.parse(JSON.parse(init.body as string)));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  return { fetch, bodies };
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits until the console has read every block up to the chain's head. */
async function caughtUp(service: ConsoleService, chain: TestChain): Promise<void> {
  const head = Number(await chain.user.publicClient.getBlockNumber({ cacheTime: 0 }));
  await until(
    () => {
      const feed = envSnapshot(service).feed;
      return feed.health === "live" && (feed.syncedBlock ?? -1) >= head;
    },
    `block ${String(head)}`,
  );
  await service.wake.settled();
}

const noBuy = (amountCents: number) => ({
  market: BTC_ABOVE_65K,
  category: Category.Crypto,
  outcome: "NO" as const,
  isBuy: true,
  amountCents,
  limitPrice: 31,
});

describe("event wake-ups from the console's pipeline", () => {
  let chain: TestChain;
  let dataDir: string;
  let service: ConsoleService;
  const rx = receiver();
  let ladder: Ladder;
  let spotCents = 0;

  function start(dir: string, fetch = rx.fetch): ConsoleService {
    const started = new ConsoleService(config(dir), openDatabase(dir), {
      env: chain.env,
      logger: silent,
      wakeFetch: fetch,
      ladder: () =>
        Promise.resolve({ ok: true, ladder: { ...ladder, spot: { ...ladder.spot, midCents: spotCents } } }),
    });
    started.start();
    return started;
  }

  beforeAll(async () => {
    chain = await startTestChain({ contract: "production" });
    ladder = await recordedLadder();
    spotCents = ladder.spot.midCents;
    dataDir = mkdtempSync(join(tmpdir(), "mandate-wake-"));
    service = start(dataDir);
    await caughtUp(service, chain);
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("never wakes for the history read on first start", () => {
    // The deployment's setPolicy happened before the console first read the chain.
    expect(rx.bodies).toEqual([]);
    expect(envSnapshot(service).wake).toMatchObject({
      enabled: true,
      usedToday: 0,
      leftToday: 6,
      recent: [],
    });
  });

  it("wakes once for an owner pause, and holds the resume until the debounce window ends", async () => {
    await chain.user.setPaused(true);
    await caughtUp(service, chain);
    expect(rx.bodies.map((b) => [b.kind, b.summary])).toEqual([
      ["mandate_changed", "The owner paused the agent."],
    ]);
    expect(rx.bodies[0]?.link).toBe(`http://localhost:3000/m/${envMandate(service).id}/rules`);
    await chain.user.setPaused(false);
    await caughtUp(service, chain);
    expect(rx.bodies).toHaveLength(1);
    expect(envSnapshot(service).wake.recent[0]).toMatchObject({ kind: "mandate_changed", status: "queued" });
  });

  it("wakes for an intent the contract rejects outside a run", async () => {
    const rejected = await chain.agent.proposeTrade(noBuy(3_000));
    expect(rejected.verdict).toBe("rejected");
    await caughtUp(service, chain);
    expect(rx.bodies.at(-1)).toMatchObject({
      kind: "intent_rejected",
      summary: `The contract rejected intent #${String(rejected.intentId)}: over max trade size.`,
      count: 1,
    });
  });

  it("wakes for a fill recorded long after its approval, not for one right after it", async () => {
    const before = rx.bodies.length;
    const quick = await chain.agent.proposeTrade(noBuy(500));
    await chain.executor.recordResult({
      intentId: quick.intentId,
      filled: true,
      filledCents: 500,
      pnlCents: 0,
    });
    await caughtUp(service, chain);
    expect(rx.bodies).toHaveLength(before);

    const late = await chain.agent.proposeTrade(noBuy(600));
    const test = createTestClient({ mode: "anvil", transport: http(chain.rpcUrl) });
    await test.increaseTime({ seconds: 600 });
    await chain.executor.recordResult({
      intentId: late.intentId,
      filled: true,
      filledCents: 600,
      pnlCents: 0,
    });
    await caughtUp(service, chain);
    expect(rx.bodies.slice(before).map((b) => [b.kind, b.summary])).toEqual([
      [
        "order_filled",
        `The executor recorded a fill for intent #${String(late.intentId)}, the latest for $6.`,
      ],
    ]);
  });

  it("does not wake for what a Bot run in progress causes", async () => {
    const before = envSnapshot(service).wake.recent.length;
    service.noteAgentActivity(envMandate(service));
    await chain.agent.proposeTrade(noBuy(3_000));
    await caughtUp(service, chain);
    expect(envSnapshot(service).wake.recent).toHaveLength(before);
  });

  it("offers each event once, whichever source delivers it", async () => {
    const events = await chain.user.getEvents({ fromBlock: 0n });
    expect(service.ingestEvents(events, "stream")).toBe(0);
    await service.wake.settled();
    const sent = rx.bodies.length;
    expect(sent).toBe(3);
  });

  it("wakes when spot falls below the floor of the current goal, once", async () => {
    const request = await recordedPlanRequest({
      quantity: "0.05",
      dropPercent: 3,
      maxCostCents: 5_000,
      maxTradeCents: 2_500,
      remainingBudgetCents: 20_000,
      requestText: "Protect my 0.05 BTC below 3% down this week.",
    });
    // As the agent API stores it: the plan is plain JSON on the wire.
    service.offchain.putPlan(envMandate(service).id, { ...request, plan: { ...request.plan } });
    service.offchain.saveHoldings(envMandate(service).id, [{ asset: "BTC", quantity: "0.05" }]);
    const floor = request.plan.floorCents ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await caughtUp(service, chain);
    const before = rx.bodies.length;
    spotCents = floor - 10_000;
    await until(() => rx.bodies.length > before, "the price wake-up");
    expect(rx.bodies.at(-1)).toMatchObject({
      kind: "price_below_floor",
      detail: { asset: "BTC", floorCents: floor, spotCents, planId: request.planId },
      link: `http://localhost:3000/m/${envMandate(service).id}/hedge`,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await service.wake.settled();
    expect(rx.bodies).toHaveLength(before + 1);
  });

  it("resends nothing after a restart, and stays within the cap", async () => {
    const recent = envSnapshot(service).wake.recent.map((d) => [d.id, d.status]);
    const sent = rx.bodies.length;
    await service.stop();
    service = start(dataDir);
    await caughtUp(service, chain);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await service.wake.settled();
    expect(rx.bodies).toHaveLength(sent);
    expect(envSnapshot(service).wake.recent.map((d) => [d.id, d.status])).toEqual(recent);
    expect(envSnapshot(service).wake.usedToday).toBe(sent);
  });

  it("shows another workspace none of these wake-ups, and its agent cannot hold them back", () => {
    expect(envSnapshot(service).wake.recent.length).toBeGreaterThan(0);
    const other = workspaceAgent(service, signUpWorkspace(service, "Other owner")).mandate;
    expect(service.snapshot(other).wake).toEqual({
      enabled: false,
      dailyCap: 6,
      usedToday: 0,
      leftToday: 6,
      recent: [],
      offReason: NO_WAKE_TARGET_REASON,
      priceCheckEveryMs: 50,
      lastPriceCheckAt: null,
      priceProblem: null,
    });

    const dir = mkdtempSync(join(tmpdir(), "mandate-wake-tenants-"));
    const fresh = new ConsoleService(config(dir), openDatabase(dir), { env: chain.env, logger: silent });
    const stranger = workspaceAgent(fresh, signUpWorkspace(fresh, "Stranger")).mandate;
    fresh.noteAgentActivity(stranger);
    expect(fresh.wake.notifier.runInProgress(Date.now())).toBe(false);
    fresh.noteAgentActivity(envMandate(fresh));
    expect(fresh.wake.notifier.runInProgress(Date.now())).toBe(true);
  });

  it("is off without a webhook, and the snapshot never carries its URL or key", async () => {
    const snapshot = JSON.stringify(envSnapshot(service));
    expect(snapshot).not.toContain("secret-path");
    expect(snapshot).not.toContain(KEY);
    expect(JSON.stringify(service.config)).not.toContain("secret-path");

    const dir = mkdtempSync(join(tmpdir(), "mandate-wake-off-"));
    const off = new ConsoleService({ ...config(dir), wake: readWakeConfig({}) }, openDatabase(dir), {
      env: chain.env,
      logger: silent,
    });
    off.start();
    await caughtUp(off, chain);
    await chain.user.setPaused(true);
    await caughtUp(off, chain);
    expect(envSnapshot(off).wake).toMatchObject({
      enabled: false,
      recent: [],
      offReason: "Set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY on the console to the routine's webhook.",
    });
    await off.stop();
  });
});
