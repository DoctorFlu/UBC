import { GatewayClient } from "@circle-fin/x402-batching/client";
import { hedgeSignalSchema, signalErrorSchema, verifyHedgeSignal } from "@mandate/shared";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHedgeRoute,
  createHedgeSignalService,
  createSignalsApp,
  DEFAULT_SIGNAL_MODEL,
} from "../src/index";
import {
  FakeGatewayFacilitator,
  GAP_RECORDED_AT,
  gappedCandlesBody,
  healedCandlesBody,
  recordedGemini,
} from "../src/testing";

/**
 * Issue #98: Gemini's public hourly candles sometimes come back with hours missing. These tests play
 * the two answers recorded on 2026-11-17 (14 hours missing, then complete five seconds later) through
 * the signal route as the agent's `buy_signal` calls it: the free probe, then the paid request.
 */
const SELLER = "0x6969C08b342f099377956e2143f3F13E91a4907D";
const WEEKLY = "http://signals.test/v1/signal/hedge?asset=BTC&horizon=weekly";
const CANDLES = "/v2/candles/btcusd/1hr";

/** Gemini answers the candle requests with these bodies in turn, repeating the last. */
function setup(candleAnswers: readonly unknown[]) {
  const now = () => GAP_RECORDED_AT;
  const gemini = recordedGemini(now, { candles: candleAnswers });
  const facilitator = new FakeGatewayFacilitator();
  const service = createHedgeSignalService({
    source: gemini.client,
    assets: ["BTC"],
    model: DEFAULT_SIGNAL_MODEL,
    now,
  });
  const app = createSignalsApp({
    sellerAddress: SELLER,
    facilitator,
    routes: [createHedgeRoute({ service, priceUsd: "0.0005" })],
  });
  const candleRequests = () => gemini.state.calls.filter((path) => path === CANDLES).length;
  return { app, facilitator, candleRequests };
}

/** A real Circle GatewayClient (throwaway key, never funded) paying the app through a stubbed fetch. */
async function buy(app: ReturnType<typeof setup>["app"]) {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init)),
  );
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: generatePrivateKey() });
  const paid = await client.pay(WEEKLY);
  expect(paid.status).toBe(200);
  const signal = hedgeSignalSchema.parse(paid.data);
  expect(verifyHedgeSignal(signal)).toBe(true);
  return signal;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /v1/signal/hedge when Gemini's hourly candles have a gap", () => {
  it("asks Gemini once when the candles have no gap", async () => {
    const { app, facilitator, candleRequests } = setup([healedCandlesBody()]);
    expect((await app.request(WEEKLY)).status).toBe(402);
    const signal = await buy(app);
    expect(signal.volatility).toMatchObject({ returns: 168, missingHours: 0 });
    expect(candleRequests()).toBe(1);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("asks once more and sells the full week when the gap heals", async () => {
    const { app, facilitator, candleRequests } = setup([gappedCandlesBody(), healedCandlesBody()]);
    expect((await app.request(WEEKLY)).status).toBe(402);
    expect(candleRequests()).toBe(2);
    const signal = await buy(app);
    expect(signal.volatility).toMatchObject({
      returns: 168,
      from: "2026-11-10T03:00:00.000Z",
      to: "2026-11-17T04:00:00.000Z",
      missingHours: 0,
    });
    // The healed answer is cached: the paid request costs Gemini nothing.
    expect(candleRequests()).toBe(2);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("sells a signal over the hours that exist, and says so, when the gap stays", async () => {
    const { app, facilitator, candleRequests } = setup([gappedCandlesBody()]);
    // Before #98 this was a free 503 insufficient_history: the newest unbroken run was 6 hours long.
    expect((await app.request(WEEKLY)).status).toBe(402);
    const signal = await buy(app);
    expect(signal.volatility).toMatchObject({
      returns: 153,
      from: "2026-11-10T03:00:00.000Z",
      to: "2026-11-17T04:00:00.000Z",
      missingHours: 14,
    });
    expect(signal.model.assumptions.join(" ")).toMatch(/no return spans a gap and no candle is filled in/);
    // One retry, then the cache: never more than two candle requests.
    expect(candleRequests()).toBe(2);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("refuses for free, with the numbers, when the gap leaves too little history", async () => {
    // Only the newest 20 rows: 6 hours after the gap and 14 before it, twice.
    const short = gappedCandlesBody().slice(0, 20);
    const { app, facilitator, candleRequests } = setup([short]);
    const res = await app.request(WEEKLY);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("payment-required")).toBeNull();
    expect(signalErrorSchema.parse(await res.json())).toEqual({
      code: "insufficient_history",
      error:
        "Only 18 hourly BTC returns are available in the 34 hours to 2026-11-17T04:00:00.000Z; Gemini's candles are missing 14 of those hours, and none is filled in. At least 24 are needed to estimate volatility.",
    });
    expect(candleRequests()).toBe(2);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });
});
