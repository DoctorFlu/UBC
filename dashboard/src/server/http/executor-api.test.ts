import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devAccount } from "@mandate/devchain";
import {
  CONSOLE_EXECUTOR_ROUTES,
  Category,
  type Settlement,
  consoleErrorSchema,
  hashSettlement,
  settlementMessage,
  settlementsResponseSchema,
  storedSettlementSchema,
} from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { type ConsoleConfig, readWakeConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { getSettlements } from "./agent-api";
import { putSettlement } from "./executor-api";

const TOKEN = "console-service-token-for-tests-0123456789";
const silent = { info: () => undefined, warn: () => undefined };

let chain: TestChain;
let dataDir: string;
let service: ConsoleService;
let filledId: number;
let heldId: number;

function makeService(): ConsoleService {
  const config: ConsoleConfig = {
    dataDir,
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: TOKEN,
    streamSecurityToken: null,
    publicUrl: "http://console.test",
    mcpPublicUrl: null,
    wake: readWakeConfig({}),
  };
  return new ConsoleService(config, openDatabase(dataDir), { env: chain.env, logger: silent });
}

async function untilIntent(id: number, status: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (service.snapshot().chain?.intents.find((intent) => intent.id === id)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`intent ${String(id)} never became ${status}`);
}

function settlementOf(intentId: number, patch: Partial<Settlement> = {}): Settlement {
  return {
    version: 1,
    chainId: chain.executor.publicClient.chain.id,
    policy: chain.address.toLowerCase() as `0x${string}`,
    intentId,
    market: BTC_ABOVE_65K,
    eventTicker: "BTC2611202200",
    strikeCents: 6_500_000,
    expiresAt: "2026-11-20T22:00:00.000Z",
    outcome: "NO",
    costCents: 1_240,
    limitPrice: 31,
    contractsHundredths: 4_000,
    resolution: "no",
    payoutCents: 4_000,
    pnlCents: 2_760,
    settlementValue: "64992.864",
    resolvedAt: "2026-11-20T22:00:08.232Z",
    venue: "simulated",
    ...patch,
  };
}

async function signed(document: Settlement, role: "executor" | "agent" = "executor") {
  const signature = await devAccount(role).signMessage({
    message: settlementMessage(hashSettlement(document)),
  });
  return { document, signature };
}

function put(intentId: number | string, body: unknown): Promise<Response> {
  const request = new Request(`http://console.test${CONSOLE_EXECUTOR_ROUTES.settlement(intentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return putSettlement(request, service, { intentId: String(intentId) });
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(consoleErrorSchema.parse(await response.json()).error.code).toBe(code);
}

beforeAll(async () => {
  chain = await startTestChain();
  const buy = {
    market: BTC_ABOVE_65K,
    category: Category.Crypto,
    outcome: "NO",
    isBuy: true,
    amountCents: 1_240,
    limitPrice: 31,
  } as const;
  filledId = (await chain.agent.proposeTrade(buy)).intentId;
  await chain.executor.recordResult({ intentId: filledId, filled: true, filledCents: 1_240, pnlCents: 0 });
  heldId = (await chain.agent.proposeTrade(buy)).intentId;
  dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
  service = makeService();
  service.start();
  await untilIntent(filledId, "executed");
  await untilIntent(heldId, "approved");
}, 60_000);

afterAll(async () => {
  await service.stop();
  await chain.stop();
});

describe("PUT /api/executor/v1/settlements/:intentId", () => {
  it("refuses a record not signed by the contract's executor, even by the agent", async () => {
    await expectError(
      await put(filledId, await signed(settlementOf(filledId), "agent")),
      403,
      "not_executor",
    );
    const forged = await signed(settlementOf(filledId));
    await expectError(
      await put(filledId, {
        ...forged,
        document: settlementOf(filledId, { resolution: "yes", payoutCents: 0, pnlCents: -1_240 }),
      }),
      403,
      "not_executor",
    );
  });

  it("refuses numbers that do not add up or do not match the fill onchain", async () => {
    await expectError(
      await put(filledId, await signed(settlementOf(filledId, { pnlCents: 0 }))),
      422,
      "invalid_settlement",
    );
    await expectError(
      await put(
        filledId,
        await signed(
          settlementOf(filledId, {
            costCents: 2_480,
            contractsHundredths: 8_000,
            payoutCents: 8_000,
            pnlCents: 5_520,
          }),
        ),
      ),
      422,
      "intent_mismatch",
    );
    await expectError(
      await put(filledId, await signed(settlementOf(filledId, { chainId: 1 }))),
      422,
      "wrong_deployment",
    );
    await expectError(await put(filledId + 1, await signed(settlementOf(filledId))), 422, "intent_mismatch");
    await expectError(await put("x", await signed(settlementOf(filledId))), 422, "invalid_parameter");
    await expectError(await put(filledId, { document: { version: 1 } }), 422, "invalid_body");
  });

  it("asks to try again for an intent the console has not seen filled", async () => {
    await expectError(await put(heldId, await signed(settlementOf(heldId))), 409, "not_executed");
  });

  it("stores the first record once, answers a repeat with it, and refuses a different one", async () => {
    const body = await signed(settlementOf(filledId));
    const created = await put(filledId, body);
    expect(created.status).toBe(201);
    const stored = storedSettlementSchema.parse(await created.json());
    expect(stored).toMatchObject({
      intentId: filledId,
      hash: hashSettlement(body.document),
      signer: devAccount("executor").address,
      document: body.document,
    });

    const again = await put(filledId, body);
    expect(again.status).toBe(200);
    expect(storedSettlementSchema.parse(await again.json()).storedAt).toBe(stored.storedAt);

    const other = await signed(
      settlementOf(filledId, { resolution: "yes", payoutCents: 0, pnlCents: -1_240 }),
    );
    await expectError(await put(filledId, other), 409, "conflict");

    const view = service.snapshot().chain?.settlements[filledId];
    expect(view).toMatchObject({ status: "verified", hash: stored.hash, document: { payoutCents: 4_000 } });
  });

  it("serves verified settlements to the agent, and flags a stored document that was edited", async () => {
    const listed = await getSettlements(
      new Request("http://console.test/api/agent/v1/settlements", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      service,
    );
    expect(listed.status).toBe(200);
    const { settlements } = settlementsResponseSchema.parse(await listed.json());
    expect(settlements.map((settlement) => settlement.intentId)).toEqual([filledId]);

    // Someone with access to the console's database rewrites the payout.
    const deploymentId = service.deploymentId ?? "";
    const row = service.settlements.get(deploymentId, filledId);
    if (row === null) throw new Error("the settlement was not stored");
    openDatabase(dataDir)
      .prepare("UPDATE settlements SET document = ? WHERE intent_id = ?")
      .run(
        JSON.stringify({ ...(row.document as Settlement), payoutCents: 9_000, pnlCents: 7_760 }),
        filledId,
      );
    service.changed();
    expect(service.snapshot().chain?.settlements[filledId]).toEqual({
      status: "tampered",
      hash: row.hash,
      storedAt: row.storedAt,
    });
    expect(service.verifiedSettlements()).toEqual([]);
  });
});
