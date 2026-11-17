/**
 * The settlement wake-up (issue #92): a ladder wakes Grok Bot's routine once, when the executor's record
 * of its last filled position is stored, carrying what the ladder cost and paid. Never once per position,
 * never again for a repeated record or after a restart.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devAccount } from "@mandate/devchain";
import {
  CONSOLE_EXECUTOR_ROUTES,
  Category,
  type Settlement,
  WakeTarget,
  type WakeEvent,
  hashSettlement,
  settlementMessage,
  wakeEventSchema,
} from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../test/support/devchain";
import { envMandate } from "../../test/support/accounts";
import { type ConsoleConfig, testConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";
import { putSettlement } from "./http/executor-api";

const silent = { info: () => undefined, warn: () => undefined };
const SECRET_URL = "https://hooks.example.test/routines/secret-path-9/run";
const KEY = "routine-key-for-settlement-tests";
const LADDER = "BTC2611202200";
// The ladder expired a minute ago: a settlement is news only within a day of its expiry.
const EXPIRED_AT = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000).toISOString();
const RESOLVED_AT = new Date(Date.parse(EXPIRED_AT) + 8_232).toISOString();

function config(dataDir: string): ConsoleConfig {
  return testConsoleConfig(dataDir, {
    pollIntervalMs: 50,
    publicUrl: "http://localhost:3000",
    wake: {
      target: new WakeTarget(SECRET_URL, KEY),
      offReason: null,
      dailyCap: 6,
      priceCheckMs: 60_000,
      testClock: false,
    },
  });
}

describe("the settlement wake-up", () => {
  let chain: TestChain;
  let dataDir: string;
  let service: ConsoleService;
  const ids: number[] = [];
  const bodies: WakeEvent[] = [];
  const fetch = (_url: string, init: RequestInit) => {
    bodies.push(wakeEventSchema.parse(JSON.parse(init.body as string)));
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const start = (dir: string) => {
    const started = new ConsoleService(config(dir), openDatabase(dir), {
      env: chain.env,
      logger: silent,
      wakeFetch: fetch,
    });
    started.start();
    return started;
  };

  /** The executor's record for a $12.40 NO buy at 31c that resolved NO: 40 contracts paid $40. */
  async function record(intentId: number): Promise<Response> {
    const document: Settlement = {
      version: 1,
      chainId: chain.executor.publicClient.chain.id,
      policy: chain.address.toLowerCase() as `0x${string}`,
      intentId,
      market: BTC_ABOVE_65K,
      eventTicker: LADDER,
      strikeCents: 6_500_000,
      expiresAt: EXPIRED_AT,
      outcome: "NO",
      costCents: 1_240,
      limitPrice: 31,
      contractsHundredths: 4_000,
      resolution: "no",
      payoutCents: 4_000,
      pnlCents: 2_760,
      settlementValue: "64250.4175",
      resolvedAt: RESOLVED_AT,
      venue: "simulated",
    };
    const signature = await devAccount("executor").signMessage({
      message: settlementMessage(hashSettlement(document)),
    });
    const request = new Request(`http://console.test${CONSOLE_EXECUTOR_ROUTES.settlement(intentId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document, signature }),
    });
    return putSettlement(request, service, { intentId: String(intentId) });
  }

  async function untilExecuted(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const intents = service.snapshot(envMandate(service)).chain?.intents ?? [];
      if (ids.every((id) => intents.find((intent) => intent.id === id)?.status === "executed")) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the fills never reached the console");
  }

  beforeAll(async () => {
    chain = await startTestChain({ contract: "production" });
    const buy = {
      market: BTC_ABOVE_65K,
      category: Category.Crypto,
      outcome: "NO",
      isBuy: true,
      amountCents: 1_240,
      limitPrice: 31,
    } as const;
    // Two positions on one ladder, filled before the console first reads the chain (history: no wake-up).
    for (let i = 0; i < 2; i += 1) {
      const { intentId } = await chain.agent.proposeTrade(buy);
      await chain.executor.recordResult({ intentId, filled: true, filledCents: 1_240, pnlCents: 0 });
      ids.push(intentId);
    }
    dataDir = mkdtempSync(join(tmpdir(), "mandate-settlement-wake-"));
    service = start(dataDir);
    await untilExecuted();
    await service.wake.settled();
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("waits for the ladder's last position, then wakes once with what the ladder cost and paid", async () => {
    expect(bodies).toEqual([]);
    expect((await record(ids[0] ?? -1)).status).toBe(201);
    await service.wake.settled();
    expect(bodies).toEqual([]);

    expect((await record(ids[1] ?? -1)).status).toBe(201);
    await service.wake.settled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      kind: "ladder_settled",
      count: 1,
      link: "http://localhost:3000/hedge",
      summary:
        "The BTC ladder BTC2611202200 settled at $64,250.42: 2 positions cost $24.80, paid $80, net +$55.20. " +
        "Plan on the next ladder.",
      detail: {
        ladders: [
          {
            asset: "BTC",
            eventTicker: LADDER,
            expiresAt: EXPIRED_AT,
            settlementValue: "64250.4175",
            positions: 2,
            costCents: 2_480,
            payoutCents: 8_000,
            pnlCents: 5_520,
          },
        ],
      },
    });
  });

  it("never wakes again for the same ladder: not for a repeated record, not after a restart", async () => {
    expect((await record(ids[1] ?? -1)).status).toBe(200);
    await service.wake.settled();
    expect(bodies).toHaveLength(1);

    await service.stop();
    service = start(dataDir);
    await untilExecuted();
    expect((await record(ids[0] ?? -1)).status).toBe(200);
    // Even if the console were asked again directly, the ladder's trigger was already recorded.
    service.settlementStored(LADDER);
    await service.wake.settled();
    expect(bodies).toHaveLength(1);
    expect(service.snapshot(envMandate(service)).wake.recent.map((wake) => wake.kind)).toEqual([
      "ladder_settled",
    ]);
  });
});
