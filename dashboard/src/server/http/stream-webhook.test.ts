import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Category } from "@mandate/shared";
import { FILTER_SCHEMA, computeQuickNodeSignature } from "@mandate/streams";
import { type Hex, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { type ConsoleConfig, readWakeConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { receiveStreamDelivery } from "./stream-webhook";

const TOKEN = "qn-test-security-token-0123456789";
const silent = { info: () => undefined, warn: () => undefined };

function config(dataDir: string, streamSecurityToken: string | null): ConsoleConfig {
  return {
    dataDir,
    // The Stream is the primary source, so the RPC only polls every 15 s: anything that shows up
    // sooner came through the webhook.
    eventSource: "stream",
    pollIntervalMs: 50,
    serviceToken: null,
    streamSecurityToken,
    publicUrl: "http://localhost:3000",
    mcpPublicUrl: null,
    wake: readWakeConfig({}),
  };
}

let counter = 0;

/** A delivery as QuickNode would send it: the filter envelope, signed over nonce + timestamp + body. */
function delivery(
  body: string,
  options: { nonce?: string; timestamp?: number; token?: string; signature?: string } = {},
): Request {
  counter += 1;
  const nonce = options.nonce ?? `nonce-${String(counter)}-${String(Date.now())}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? computeQuickNodeSignature(options.token ?? TOKEN, nonce, timestamp, body);
  return new Request("http://localhost/api/webhooks/quicknode", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signature,
    },
    body,
  });
}

/** Raw JSON-RPC logs of one block, wrapped in the envelope streams/filter.js produces. */
async function envelopeForBlock(chain: TestChain, blockNumber: bigint, address?: Hex): Promise<string> {
  const logs = await chain.user.publicClient.request({
    method: "eth_getLogs",
    params: [
      { address: address ?? chain.address, fromBlock: toHex(blockNumber), toBlock: toHex(blockNumber) },
    ],
  });
  return JSON.stringify({
    schema: FILTER_SCHEMA,
    network: "arc-testnet",
    stream_id: "test-stream",
    batch_start_range: Number(blockNumber),
    batch_end_range: Number(blockNumber),
    blocks_reorged: [],
    logs,
  });
}

describe("QuickNode Stream webhook", () => {
  let chain: TestChain;
  let service: ConsoleService;

  beforeAll(async () => {
    chain = await startTestChain();
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    service = new ConsoleService(config(dataDir, TOKEN), openDatabase(dataDir), {
      env: chain.env,
      logger: silent,
    });
    service.start();
    if (!(await service.whenSynced(15_000))) throw new Error("the console did not sync");
  }, 60_000);

  afterAll(async () => {
    await service.stop();
    await chain.stop();
  });

  it("stores a valid delivery and shows it before the RPC poller would", async () => {
    const proposal = await chain.agent.proposeTrade({
      market: BTC_ABOVE_65K,
      category: Category.Crypto,
      outcome: "YES",
      isBuy: true,
      amountCents: 1_000,
      limitPrice: 65,
    });
    expect(service.snapshot().chain?.intents.some((intent) => intent.id === proposal.intentId)).toBe(false);

    const body = await envelopeForBlock(chain, BigInt(proposal.blockNumber));
    const response = await receiveStreamDelivery(delivery(body), service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stored", received: 1, stored: 1 });
    await expect
      .poll(() => service.snapshot().chain?.intents.find((intent) => intent.id === proposal.intentId)?.status)
      .toBe("approved");
  });

  it("acknowledges a replayed nonce without processing it, and ignores a re-signed duplicate batch", async () => {
    const proposal = await chain.agent.proposeTrade({
      market: BTC_ABOVE_65K,
      category: Category.Crypto,
      outcome: "YES",
      isBuy: true,
      amountCents: 2_200,
      limitPrice: 65,
    });
    const body = await envelopeForBlock(chain, BigInt(proposal.blockNumber));
    const first = await receiveStreamDelivery(delivery(body, { nonce: "replayed-nonce" }), service);
    expect(await first.json()).toMatchObject({ status: "stored", stored: 1 });
    const eventsAfterFirst = service.snapshot().chain?.events.length;

    const replay = await receiveStreamDelivery(delivery(body, { nonce: "replayed-nonce" }), service);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "duplicate" });

    const redelivered = await receiveStreamDelivery(delivery(body), service);
    expect(redelivered.status).toBe(200);
    expect(await redelivered.json()).toEqual({ status: "stored", received: 1, stored: 0 });
    expect(service.snapshot().chain?.events.length).toBe(eventsAfterFirst);
  });

  it("refuses a tampered body, a wrong token, a stale timestamp and missing headers with 401", async () => {
    const body = await envelopeForBlock(chain, chain.deployBlock);
    const signed = computeQuickNodeSignature(TOKEN, "n-tamper", "1", body);
    const cases: [string, Request][] = [
      [
        "tampered body",
        delivery(body.replace("test-stream", "evil-stream"), {
          nonce: "n-tamper",
          timestamp: Math.floor(Date.now() / 1000),
          signature: signed,
        }),
      ],
      ["wrong token", delivery(body, { token: "some-other-token" })],
      ["stale timestamp", delivery(body, { timestamp: Math.floor(Date.now() / 1000) - 3_600 })],
      ["missing headers", new Request("http://localhost/api/webhooks/quicknode", { method: "POST", body })],
    ];
    for (const [name, request] of cases) {
      const response = await receiveStreamDelivery(request, service);
      expect(response.status, name).toBe(401);
      const error = (await response.json()) as { error: { code: string; message: string } };
      expect(error.error.message.length, name).toBeGreaterThan(0);
    }
  });

  it("answers 400 for a signed body that is not JSON and 422 for one that is not a Stream payload", async () => {
    const notJson = await receiveStreamDelivery(delivery("not json"), service);
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: { code: "invalid_json" } });

    const wrongShape = await receiveStreamDelivery(delivery(JSON.stringify({ hello: "world" })), service);
    expect(wrongShape.status).toBe(422);
    expect(await wrongShape.json()).toMatchObject({ error: { code: "invalid_payload" } });
  });

  it("ignores logs from other contracts", async () => {
    const body = JSON.stringify({
      schema: FILTER_SCHEMA,
      network: "arc-testnet",
      logs: [
        {
          address: "0x000000000000000000000000000000000000dead",
          topics: [`0x${"11".repeat(32)}`],
          data: "0x",
          blockNumber: "0x1",
          blockHash: `0x${"22".repeat(32)}`,
          blockTimestamp: "0x6afa11cf",
          transactionHash: `0x${"33".repeat(32)}`,
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        },
      ],
    });
    const response = await receiveStreamDelivery(delivery(body), service);
    expect(await response.json()).toEqual({ status: "stored", received: 0, stored: 0 });
  });

  it("answers 503 when the webhook has no security token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-console-"));
    const disabled = new ConsoleService(config(dataDir, null), openDatabase(dataDir), {
      env: chain.env,
      logger: silent,
    });
    const response = await receiveStreamDelivery(delivery("{}"), disabled);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "stream_disabled" } });
  });
});
