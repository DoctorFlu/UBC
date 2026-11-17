/**
 * The executor's order journal and venue announcement (issue #93) on the console's executor API, and the
 * Gemini venue writing through it to the real route handlers: the console stores only what the
 * contract's executor signed, for an intent it has seen, and only versions that move forward.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  consoleOrderJournal,
  devAccount,
  geminiVenue,
  type OrderJournal,
  type RecordSigner,
} from "@mandate/devchain";
import { eventSchema, normalizeEvent } from "@mandate/gemini";
import { createGeminiPrivateClient } from "@mandate/gemini/private";
import { FakeGeminiPrivate, unpacedLimiter } from "@mandate/gemini/testing";
import {
  CONSOLE_EXECUTOR_ROUTES,
  Category,
  type ExecutorVenue,
  type VenueOrderRecord,
  clientOrderIdFor,
  consoleErrorSchema,
  hashExecutorRecord,
} from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BTC_ABOVE_65K, type TestChain, startTestChain } from "../../../test/support/devchain";
import { type ConsoleConfig, readWakeConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { getVenueOrder, putExecutorVenue, putVenueOrder } from "./executor-orders-api";

const silent = { info: () => undefined, warn: () => undefined };
const FIXTURES = fileURLToPath(new URL("../../../../gemini/test/fixtures/", import.meta.url));
const OPEN_EVENT = normalizeEvent(
  eventSchema.parse(JSON.parse(readFileSync(`${FIXTURES}event-BTC2611202200.json`, "utf8"))),
);

let chain: TestChain;
let service: ConsoleService;
let placedId: number;
let journalId: number;
let unseenId: number;

const executorSign: RecordSigner = (hash) => devAccount("executor").signMessage({ message: { raw: hash } });
const agentSign: RecordSigner = (hash) => devAccount("agent").signMessage({ message: { raw: hash } });
type ConsoleMarketData = Parameters<typeof putExecutorVenue>[0];
/** A console on Gemini's sandbox, as `EXECUTOR_VENUE=gemini` with the default `GEMINI_ENV` makes it. */
const sandboxConsole: ConsoleMarketData = () => ({
  environment: "sandbox",
  settings: "EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox",
});

/** The console's executor routes, reached the way `consoleOrderJournal` reaches them over HTTP. */
async function consoleFetch(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  const request = new Request(url, init);
  if (url.pathname === CONSOLE_EXECUTOR_ROUTES.venue)
    return putExecutorVenue(sandboxConsole)(request, service, {});
  const match = /^\/api\/executor\/v1\/orders\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1]) return new Response("<html>Not found</html>", { status: 404 });
  const params = { intentId: decodeURIComponent(match[1]) };
  return request.method === "PUT"
    ? putVenueOrder(request, service, params)
    : getVenueOrder(request, service, params);
}

function journal(sign: RecordSigner = executorSign): OrderJournal {
  return consoleOrderJournal({ consoleUrl: "http://console.test", sign, fetch: consoleFetch });
}

function record(intentId: number, patch: Partial<VenueOrderRecord> = {}): VenueOrderRecord {
  const policy = chain.address.toLowerCase() as `0x${string}`;
  const chainId = chain.executor.publicClient.chain.id;
  return {
    kind: "venue-order",
    version: 1,
    chainId,
    policy,
    intentId,
    revision: 1,
    venue: "gemini",
    environment: "sandbox",
    clientOrderId: clientOrderIdFor(chainId, policy, intentId),
    market: BTC_ABOVE_65K,
    side: "buy",
    outcome: "NO",
    quantityHundredths: 4_000,
    limitPrice: 31,
    state: "placing",
    venueOrderId: null,
    filledHundredths: 0,
    filledCents: 0,
    detail: null,
    placedAt: "2026-11-17T08:00:00.000Z",
    updatedAt: "2026-11-17T08:00:00.000Z",
    ...patch,
  };
}

async function putRaw(intentId: number, document: VenueOrderRecord, sign = executorSign) {
  const signature = await sign(hashExecutorRecord(document));
  return consoleFetch(`http://console.test${CONSOLE_EXECUTOR_ROUTES.order(intentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document, signature }),
  });
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(consoleErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function untilApproved(id: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (service.snapshot().chain?.intents.find((intent) => intent.id === id)?.status === "approved") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`intent ${String(id)} never became approved`);
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
  placedId = (await chain.agent.proposeTrade(buy)).intentId;
  journalId = (await chain.agent.proposeTrade(buy)).intentId;
  const config: ConsoleConfig = {
    dataDir: mkdtempSync(join(tmpdir(), "mandate-console-")),
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: "console-service-token-for-tests-0123456789",
    streamSecurityToken: null,
    publicUrl: "http://console.test",
    mcpPublicUrl: null,
    wake: readWakeConfig({}),
  };
  service = new ConsoleService(config, openDatabase(config.dataDir), { env: chain.env, logger: silent });
  service.start();
  await untilApproved(placedId);
  await untilApproved(journalId);
  unseenId = journalId + 1;
}, 60_000);

afterAll(async () => {
  await service.stop();
  await chain.stop();
});

describe("the executor's order journal in the console", () => {
  it("answers none for an intent without a record, and a non-console 404 is an outage, not none", async () => {
    expect(await journal().get(journalId)).toBeNull();
    const lost = consoleOrderJournal({
      consoleUrl: "http://console.test",
      sign: executorSign,
      fetch: () => Promise.resolve(new Response("<html>Not found</html>", { status: 404 })),
    });
    await expect(lost.get(journalId)).rejects.toThrow(/no order journal at this address/);
    const down = consoleOrderJournal({
      consoleUrl: "http://console.test",
      sign: executorSign,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(down.get(journalId)).rejects.toThrow(/did not answer/);
  });

  it("stores only what the contract's executor signed, for an intent it has seen, matching it", async () => {
    await expectError(await putRaw(journalId, record(journalId), agentSign), 403, "not_executor");
    await expectError(await putRaw(unseenId, record(unseenId)), 409, "not_seen");
    await expectError(await putRaw(journalId, record(journalId, { limitPrice: 30 })), 422, "intent_mismatch");
    await expectError(await putRaw(journalId, record(journalId, { outcome: "YES" })), 422, "intent_mismatch");
    await expectError(await putRaw(journalId, record(journalId, { chainId: 1 })), 422, "wrong_deployment");
    await expectError(await putRaw(journalId + 1000, record(journalId)), 422, "intent_mismatch");
    await expectError(
      await putRaw(journalId, record(journalId, { filledHundredths: 5_000 })),
      422,
      "invalid_order",
    );
  });

  it("keeps versions moving forward: higher revisions, fixed terms, nothing after the order closed", async () => {
    const first = record(journalId);
    expect((await putRaw(journalId, first)).status).toBe(201);
    expect((await putRaw(journalId, first)).status).toBe(200);
    expect(await journal().get(journalId)).toEqual(first);

    await expectError(await putRaw(journalId, record(journalId, { state: "open" })), 409, "stale");
    await expectError(
      await putRaw(journalId, record(journalId, { revision: 2, quantityHundredths: 3_000 })),
      409,
      "conflict",
    );
    const open = record(journalId, {
      revision: 2,
      state: "open",
      venueOrderId: "101",
      filledHundredths: 1_000,
    });
    expect((await putRaw(journalId, open)).status).toBe(201);
    await expectError(
      await putRaw(journalId, record(journalId, { revision: 3, state: "open", venueOrderId: "102" })),
      409,
      "conflict",
    );
    await expectError(
      await putRaw(journalId, record(journalId, { revision: 3, state: "open", venueOrderId: "101" })),
      409,
      "conflict",
    );
    const filled = {
      ...open,
      revision: 3,
      state: "filled" as const,
      filledHundredths: 4_000,
      filledCents: 1_240,
    };
    expect((await putRaw(journalId, filled)).status).toBe(201);
    await expectError(await putRaw(journalId, { ...filled, revision: 4, state: "open" }), 409, "conflict");
    // A closed order's note can still change: a settlement problem found later.
    const noted = { ...filled, revision: 4, detail: "settlement disagreement: checked by hand" };
    expect((await putRaw(journalId, noted)).status).toBe(201);
    expect(service.snapshot().chain?.venueOrders[journalId]).toMatchObject({
      state: "filled",
      venueOrderId: "101",
      detail: "settlement disagreement: checked by hand",
    });
  });

  it("carries a real placement through the console: placed once, followed, and shown", async () => {
    const fake = new FakeGeminiPrivate({ apiKey: "account-FAKEKEY", apiSecret: "fake-secret" });
    const gemini = geminiVenue({
      publicClient: { getEvent: () => Promise.resolve(OPEN_EVENT) },
      trading: createGeminiPrivateClient({
        environment: "sandbox",
        credentials: { apiKey: "account-FAKEKEY", apiSecret: "fake-secret" },
        fetch: fake.fetch,
        limiter: unpacedLimiter(),
      }),
      journal: journal(),
      deployment: {
        chainId: chain.executor.publicClient.chain.id,
        policy: chain.address.toLowerCase() as `0x${string}`,
      },
    });
    const order = {
      intentId: placedId,
      market: BTC_ABOVE_65K,
      outcome: "NO" as const,
      isBuy: true,
      amountCents: 1_240,
      limitPrice: 31,
    };
    const placement = await gemini.placeOrder(order);
    if (placement.status !== "placed") throw new Error(JSON.stringify(placement));
    // Asked again (a restart): found in the journal, not sent again.
    expect(await gemini.placeOrder(order)).toEqual(placement);
    expect(fake.callsTo("/v1/prediction-markets/order")).toHaveLength(1);

    fake.fill(placement.placed.venueOrderId);
    expect(await gemini.readFill(placement.placed)).toMatchObject({ state: "closed", filledCents: 1_240 });
    expect(service.snapshot().chain?.venueOrders[placedId]).toMatchObject({
      venue: "gemini",
      environment: "sandbox",
      state: "filled",
      venueOrderId: placement.placed.venueOrderId,
      filledHundredths: 4_000,
    });
  });

  it("shows the venue the executor announced, signed by it, and never an older announcement", async () => {
    const announce = async (document: ExecutorVenue, sign = executorSign, console = sandboxConsole) => {
      const signature = await sign(hashExecutorRecord(document));
      return putExecutorVenue(console)(
        new Request(`http://console.test${CONSOLE_EXECUTOR_ROUTES.venue}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document, signature }),
        }),
        service,
        {},
      );
    };
    const base: ExecutorVenue = {
      kind: "executor-venue",
      version: 1,
      chainId: chain.executor.publicClient.chain.id,
      policy: chain.address.toLowerCase() as `0x${string}`,
      venue: "gemini",
      environment: "sandbox",
      announcedAt: "2026-11-17T08:00:00.000Z",
    };
    expect(service.snapshot().chain?.venue).toBeNull();
    await expectError(await announce(base, agentSign), 403, "not_executor");
    await expectError(await announce({ ...base, environment: null }), 422, "invalid_body");
    expect((await announce(base)).status).toBe(201);
    expect(service.snapshot().chain?.venue).toEqual({
      venue: "gemini",
      environment: "sandbox",
      announcedAt: base.announcedAt,
    });
    await expectError(await announce({ ...base, announcedAt: "2026-11-17T07:00:00.000Z" }), 409, "stale");
  });

  it("refuses an executor that reads another Gemini than the console, naming both sides' settings", async () => {
    const announce = async (document: ExecutorVenue, console: ConsoleMarketData) => {
      const signature = await executorSign(hashExecutorRecord(document));
      return putExecutorVenue(console)(
        new Request(`http://console.test${CONSOLE_EXECUTOR_ROUTES.venue}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document, signature }),
        }),
        service,
        {},
      );
    };
    const gemini: ExecutorVenue = {
      kind: "executor-venue",
      version: 1,
      chainId: chain.executor.publicClient.chain.id,
      policy: chain.address.toLowerCase() as `0x${string}`,
      venue: "gemini",
      environment: "sandbox",
      announcedAt: "2026-11-17T09:00:00.000Z",
    };
    const productionConsole: ConsoleMarketData = () =>
      ({ environment: "production", settings: "EXECUTOR_VENUE=simulated (the default)" }) as const;
    const shown = service.snapshot().chain?.venue;
    const refused = await announce(gemini, productionConsole);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: {
        code: "environment_mismatch",
        message:
          "This console reads Gemini (production) (EXECUTOR_VENUE=simulated (the default)), but the executor " +
          "reads Gemini's sandbox (EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox). Give the executor, the console, " +
          "the MCP server and the signal service the same EXECUTOR_VENUE and GEMINI_ENV.",
      },
    });
    // The simulated executor reads production, so a sandbox console refuses it too.
    const simulated: ExecutorVenue = { ...gemini, venue: "simulated", environment: null };
    await expectError(await announce(simulated, sandboxConsole), 409, "environment_mismatch");
    // Nothing refused is shown.
    expect(service.snapshot().chain?.venue).toEqual(shown);
    expect((await announce(simulated, productionConsole)).status).toBe(201);
    expect(service.snapshot().chain?.venue?.venue).toBe("simulated");
  });
});
