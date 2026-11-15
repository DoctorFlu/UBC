/**
 * Test helpers: an offline Circle Gateway facilitator, recorded Gemini market data, and a complete
 * signals app built from both. Nothing here touches the network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLadder,
  candlesSchema,
  createGeminiClient,
  eventSchema,
  normalizeCandles,
  normalizeEvent,
  normalizeTicker,
  tickerSchema,
  type Candle,
  type FetchLike,
  type Ladder,
} from "@mandate/gemini";
import { ARC_TESTNET } from "@mandate/shared";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { Address } from "viem";
import { createSignalsApp } from "./app";
import { createHedgeRoute } from "./routes/hedge";
import { helloRoute } from "./routes/hello";
import { DEFAULT_SIGNAL_MODEL } from "./signal/build";
import { createHedgeSignalService } from "./signal/service";

/**
 * Offline stand-in for Circle Gateway's x402 facilitator.
 * `getSupported` returns the Arc testnet kind exactly as https://gateway-api-testnet.circle.com/v1/x402/supported
 * returned it on 2026-11-15; `verify` and `settle` record their calls and answer with what the test sets.
 */
export class FakeGatewayFacilitator implements FacilitatorClient {
  readonly verifyCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];
  readonly settleCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];

  constructor(
    public verifyResult: (payload: PaymentPayload) => VerifyResponse = (payload) => ({
      isValid: true,
      payer: payerOf(payload),
    }),
    public settleResult: (payload: PaymentPayload) => SettleResponse = (payload) => ({
      success: true,
      transaction: "fake-gateway-transfer",
      network: ARC_TESTNET.network,
      payer: payerOf(payload),
    }),
  ) {}

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls.push({ payload, requirements });
    return Promise.resolve(this.verifyResult(payload));
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls.push({ payload, requirements });
    return Promise.resolve(this.settleResult(payload));
  }

  getSupported() {
    return Promise.resolve({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: ARC_TESTNET.network,
          extra: {
            name: "GatewayWalletBatched",
            version: "1",
            verifyingContract: ARC_TESTNET.gatewayWallet.toLowerCase(),
            minValiditySeconds: 604800,
            assets: [
              { symbol: "USDC", address: ARC_TESTNET.usdc, decimals: 6, authorizationVersions: ["1", "2"] },
            ],
          },
        },
      ],
      extensions: [],
      signers: { "eip155:*": [] },
    } as Awaited<ReturnType<FacilitatorClient["getSupported"]>>);
  }
}

function payerOf(payload: PaymentPayload): string {
  const authorization = payload.payload.authorization as { from?: unknown } | undefined;
  return typeof authorization?.from === "string" ? authorization.from : "";
}

/** Gemini responses recorded on 2026-11-15 (see gemini/scripts/record-fixtures.ts). */
const FIXTURES = join(import.meta.dirname, "..", "..", "gemini", "test", "fixtures");

/** When the recorded event, ticker and candles were live. */
export const RECORDED_AT = Date.parse("2026-11-15T20:19:00Z");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** The weekly BTC ladder settling 2026-11-20 22:00 UTC: 21 strikes from $61,000 to $71,000. */
export function weeklyLadder(): Ladder {
  const event = normalizeEvent(eventSchema.parse(fixture("event-BTC2611202200.json")));
  const fetchedAt = new Date(RECORDED_AT).toISOString();
  const spot = normalizeTicker("BTC", tickerSchema.parse(fixture("pubticker-btcusd.json")), fetchedAt);
  if (spot === null) throw new Error("fixture spot has no price");
  const ladder = buildLadder(event, spot, { fetchedAt });
  if (ladder === null) throw new Error("fixture event is not a ladder");
  return ladder;
}

/** 200 hourly BTC candles, the newest opening at 19:00 UTC on the recording day. */
export function hourlyCandles(): Candle[] {
  return normalizeCandles(candlesSchema.parse(fixture("candles-btcusd-1hr.json")));
}

const RECORDED_PATHS: Record<string, string> = {
  "/v1/prediction-markets/events/BTC2611202200": "event-BTC2611202200.json",
  "/v1/pubticker/btcusd": "pubticker-btcusd.json",
  "/v2/candles/btcusd/1hr": "candles-btcusd-1hr.json",
};

/**
 * A Gemini client whose fetch answers from the recorded fixtures and counts requests. Set `failing` to
 * make every request fail as if Gemini were down.
 */
export function recordedGemini(now = () => RECORDED_AT) {
  const state = { calls: [] as string[], failing: false };
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl: FetchLike = (input) => {
    const url = new URL(input);
    const path = url.pathname + url.search;
    state.calls.push(path);
    if (state.failing) return Promise.resolve(new Response("upstream down", { status: 503 }));
    const recorded = RECORDED_PATHS[path];
    if (recorded !== undefined) return Promise.resolve(respond(fixture(recorded)));
    if (path.startsWith("/v1/prediction-markets/events?")) {
      return Promise.resolve(respond(fixture("events-crypto.json")));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  };
  const client = createGeminiClient({
    fetch: fetchImpl,
    now,
    sleep: () => Promise.resolve(),
    random: () => 0,
    maxRetries: 0,
    // The clock stands still in tests, so a bucket that ran dry would never refill.
    rateLimit: { capacity: 1_000 },
  });
  return { client, state };
}

/**
 * The whole seller, offline: hello and hedge routes, recorded Gemini data and a fake facilitator.
 * The hedge signal costs `priceUsd` (default 0.0005).
 */
export function recordedSignalsApp(
  options: { sellerAddress?: Address; priceUsd?: string; now?: () => number } = {},
) {
  const now = options.now ?? (() => RECORDED_AT);
  const gemini = recordedGemini(now);
  const facilitator = new FakeGatewayFacilitator();
  const service = createHedgeSignalService({
    source: gemini.client,
    assets: ["BTC", "ETH"],
    model: DEFAULT_SIGNAL_MODEL,
    now,
  });
  const app = createSignalsApp({
    sellerAddress: options.sellerAddress ?? "0x6969C08b342f099377956e2143f3F13E91a4907D",
    facilitator,
    routes: [helloRoute, createHedgeRoute({ service, priceUsd: options.priceUsd ?? "0.0005" })],
  });
  return { app, facilitator, gemini };
}
