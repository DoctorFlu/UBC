import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET, hedgeSignalSchema, signalErrorSchema, verifyHedgeSignal } from "@mandate/shared";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHedgeRoute,
  createHedgeSignalService,
  createSignalsApp,
  DEFAULT_SIGNAL_MODEL,
  helloRoute,
  type ResourceCatalog,
} from "../src/index";
import { FakeGatewayFacilitator, recordedGemini, RECORDED_AT } from "../src/testing";

const SELLER = "0x6969C08b342f099377956e2143f3F13E91a4907D";
const BASE = "http://signals.test";
const WEEKLY = `${BASE}/v1/signal/hedge?asset=BTC&horizon=weekly`;

function setup(options: { now?: () => number } = {}) {
  const gemini = recordedGemini(options.now);
  const facilitator = new FakeGatewayFacilitator();
  const service = createHedgeSignalService({
    source: gemini.client,
    assets: ["BTC", "ETH"],
    model: DEFAULT_SIGNAL_MODEL,
    now: options.now ?? (() => RECORDED_AT),
  });
  const app = createSignalsApp({
    sellerAddress: SELLER,
    facilitator,
    routes: [helloRoute, createHedgeRoute({ service, priceUsd: "0.0005" })],
  });
  return { app, facilitator, gemini };
}

function decodeRequired(res: Response): { accepts: { amount: string; payTo: string; network: string }[] } {
  const header = res.headers.get("payment-required");
  if (header === null) throw new Error("no payment-required header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { amount: string; payTo: string; network: string }[];
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /v1/resources", () => {
  it("describes the hedge signal: price, query and response schema", async () => {
    const { app, gemini } = setup();
    const catalog = (await (await app.request(`${BASE}/v1/resources`)).json()) as ResourceCatalog;
    const hedge = catalog.resources.find((r) => r.path === "/v1/signal/hedge");
    expect(hedge).toMatchObject({
      method: "GET",
      url: `${BASE}/v1/signal/hedge`,
      priceUsd: "0.0005",
      amount: "500",
      asset: ARC_TESTNET.usdc,
      scheme: "exact",
      settlement: "GatewayWalletBatched",
      mimeType: "application/json",
    });
    expect(hedge?.query?.map((q) => [q.name, q.required])).toEqual([
      ["asset", true],
      ["eventTicker", false],
      ["expiry", false],
      ["horizon", false],
    ]);
    expect(hedge?.responseSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["signalId", "strikes"]) as unknown,
    });
    expect(hedgeSignalSchema.safeParse(hedge?.exampleResponse).success).toBe(true);
    // Discovery never touches Gemini.
    expect(gemini.state.calls).toEqual([]);
  });
});

describe("GET /v1/signal/hedge without payment", () => {
  it("answers 402 with Gateway payment requirements once the signal is ready", async () => {
    const { app, facilitator } = setup();
    const res = await app.request(WEEKLY);
    expect(res.status).toBe(402);
    const [option] = decodeRequired(res).accepts;
    expect(option).toMatchObject({ amount: "500", payTo: SELLER, network: "eip155:5042002" });
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it.each([
    ["no selection", "?asset=BTC", 400, "invalid_query"],
    ["two selections", "?asset=BTC&horizon=weekly&eventTicker=BTC2611202200", 400, "invalid_query"],
    ["a repeated parameter", "?asset=BTC&asset=ETH&horizon=weekly", 400, "invalid_query"],
    ["an unknown parameter", "?asset=BTC&horizon=weekly&x=1", 400, "invalid_query"],
    ["an asset not covered", "?asset=DOGE&horizon=weekly", 404, "unknown_asset"],
    ["an expiry with no ladder", "?asset=BTC&expiry=2026-11-21T22:00:00Z", 404, "no_ladder"],
    ["an unknown event", "?asset=BTC&eventTicker=BTC2612312200", 404, "no_ladder"],
  ])("refuses %s for free, before any 402", async (_name, search, status, code) => {
    const { app, facilitator } = setup();
    const res = await app.request(`${BASE}/v1/signal/hedge${search}`);
    expect(res.status).toBe(status);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(signalErrorSchema.parse(await res.json()).code).toBe(code);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("refuses an expired ladder for free", async () => {
    const { app } = setup({ now: () => Date.parse("2026-11-20T21:59:30Z") });
    const res = await app.request(`${BASE}/v1/signal/hedge?asset=BTC&eventTicker=BTC2611202200`);
    expect(res.status).toBe(422);
    expect(signalErrorSchema.parse(await res.json()).code).toBe("expired");
  });

  it("answers 503 with Retry-After when Gemini is down, and never asks for payment", async () => {
    const { app, gemini } = setup();
    gemini.state.failing = true;
    const res = await app.request(WEEKLY);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("payment-required")).toBeNull();
    expect(signalErrorSchema.parse(await res.json()).code).toBe("market_data_unavailable");
  });

  it("caches market data, so repeated requests cost Gemini nothing", async () => {
    const { app, gemini } = setup();
    for (let i = 0; i < 5; i++) expect((await app.request(WEEKLY)).status).toBe(402);
    // One events page, one event, one ticker and one candle series.
    expect(gemini.state.calls).toHaveLength(4);
  });
});

describe("GET /v1/signal/hedge with payment", () => {
  /** A real Circle GatewayClient (throwaway key, never funded) paying the app through a stubbed fetch. */
  function payingClient(app: ReturnType<typeof setup>["app"]) {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init)),
    );
    return new GatewayClient({ chain: "arcTestnet", privateKey: generatePrivateKey() });
  }

  it("serves the signal and settles exactly once", async () => {
    const { app, facilitator } = setup();
    const client = payingClient(app);
    const paid = await client.pay(WEEKLY);
    expect(paid.status).toBe(200);
    expect(paid.amount).toBe(500n);
    const signal = hedgeSignalSchema.parse(paid.data);
    expect(verifyHedgeSignal(signal)).toBe(true);
    expect(signal).toMatchObject({ asset: "BTC", eventTicker: "BTC2611202200", horizon: "weekly" });
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("never verifies or settles when the market data fails between the 402 and the paid retry", async () => {
    const { app, facilitator, gemini } = setup();
    // Let the unpaid request through, then fail Gemini for the paid retry with an empty cache.
    const realFetch = app.fetch.bind(app);
    let requests = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (requests === 2) {
        gemini.client.clearCache();
        gemini.state.failing = true;
      }
      return realFetch(new Request(input, init));
    });
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: generatePrivateKey() });
    await expect(client.pay(WEEKLY)).rejects.toThrow(/Gemini market data could not be loaded/);
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});
