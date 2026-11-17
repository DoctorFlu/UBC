import {
  HEDGE_SIGNAL_PATH,
  hedgeSignalQuerySchema,
  hedgeSignalSchema,
  SIGNAL_HORIZONS,
  type HedgeSignal,
  type SignalError,
} from "@mandate/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { PaidRoute } from "../paid-route";
import { MODEL_ASSUMPTIONS } from "../signal/build";
import { refusal, type HedgeSignalService, type PrepareResult } from "../signal/service";

/**
 * `GET /v1/signal/hedge`: the paid hedge signal (issue #20).
 *
 * Everything that can fail happens in `precheck`, before the payment middleware: parsing the query,
 * loading the ladder and candles from Gemini (cached), and computing the signal. A refusal there is
 * free and the buyer never signs. The paid handler only returns the document computed for this very
 * request, so a paid request cannot fail for a reason the seller could have known beforehand.
 */
export function createHedgeRoute(options: { service: HedgeSignalService; priceUsd: string }): PaidRoute {
  const prepared = new WeakMap<Request, HedgeSignal>();

  return {
    method: "GET",
    path: HEDGE_SIGNAL_PATH,
    priceUsd: options.priceUsd,
    description:
      `Hedge signal for an asset's "at or above" ladder on Gemini: realised volatility, implied and model ` +
      `probabilities at each strike, and whether buying NO (protection) is cheap, fair or expensive there. ` +
      `Covers ${options.service.assets.join(", ")}.`,
    exampleResponse: EXAMPLE_SIGNAL,
    query: [
      {
        name: "asset",
        required: true,
        description: `Underlying, one of ${options.service.assets.join(", ")}.`,
      },
      {
        name: "eventTicker",
        required: false,
        description:
          "Gemini event ticker of the ladder, for example BTC2611202200. Pass exactly one of eventTicker, expiry or horizon.",
      },
      {
        name: "expiry",
        required: false,
        description: "ISO 8601 settlement time of the ladder, for example 2026-11-20T22:00:00.000Z.",
      },
      {
        name: "horizon",
        required: false,
        description: `Soonest open ladder of this kind: ${SIGNAL_HORIZONS.join(", ")}.`,
      },
    ],
    responseSchema: z.toJSONSchema(hedgeSignalSchema),
    precheck: async (c) => {
      const result = await prepareFromRequest(c, options.service);
      if (!result.ok) return refuse(c, result);
      prepared.set(c.req.raw, result.signal);
      return undefined;
    },
    handler: (c) => {
      const signal = prepared.get(c.req.raw);
      // Unreachable while precheck runs first; a 5xx here also stops settlement, so nobody pays for it.
      if (signal === undefined) {
        return refuse(
          c,
          refusal("market_data_unavailable", "The signal was not prepared; nothing was charged."),
        );
      }
      c.header("cache-control", "no-store");
      return c.json(signal);
    },
  };
}

async function prepareFromRequest(c: Context, service: HedgeSignalService): Promise<PrepareResult> {
  const params = new URL(c.req.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in raw) return refusal("invalid_query", `Pass ${key} only once.`);
    raw[key] = value;
  }
  const query = hedgeSignalQuerySchema.safeParse(raw);
  if (!query.success) {
    const issue = query.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return refusal("invalid_query", `${where}${issue?.message ?? "invalid query"}`);
  }
  return service.prepare(query.data);
}

function refuse(c: Context, result: Extract<PrepareResult, { ok: false }>): Response {
  const body: SignalError = { error: result.message, code: result.code };
  c.header("cache-control", "no-store");
  if (result.status === 503) c.header("retry-after", "60");
  return c.json(body, result.status);
}

/** Shape of a paid response, shown on the discovery endpoint. Numbers are illustrative. */
const EXAMPLE_SIGNAL: HedgeSignal = {
  version: 1,
  signalId: `0x${"0".repeat(64)}`,
  asset: "BTC",
  eventTicker: "BTC2611202200",
  horizon: "weekly",
  expiry: "2026-11-20T22:00:00.000Z",
  asOf: "2026-11-15T20:19:00.000Z",
  secondsToExpiry: 438_060,
  spot: { midCents: 6_471_001, source: "gemini:btcusd", fetchedAt: "2026-11-15T20:19:00.000Z" },
  volatility: {
    annualizedBps: 3_870,
    method: "close-to-close",
    candle: "1hr",
    returns: 168,
    from: "2026-11-08T19:00:00.000Z",
    to: "2026-11-15T20:00:00.000Z",
    missingHours: 0,
    source: "gemini:btcusd",
  },
  model: { name: "lognormal-driftless", fairBandBps: 200, assumptions: [...MODEL_ASSUMPTIONS] },
  strikes: [
    {
      strikeCents: 6_300_000,
      instrumentSymbol: "GEMI-BTC2611202200-HI63000",
      marketState: "open",
      book: "two_sided",
      yesBidCents: 71,
      yesAskCents: 75,
      impliedYesBps: 7_300,
      modelYesBps: 6_912,
      noAskCents: 29,
      fairNoBps: 3_088,
      edgeBps: 188,
      edgeCents: 2,
      verdict: "fair",
    },
    {
      strikeCents: 6_400_000,
      instrumentSymbol: "GEMI-BTC2611202200-HI64000",
      marketState: "open",
      book: "no_asks",
      yesBidCents: 62,
      yesAskCents: null,
      impliedYesBps: null,
      modelYesBps: 5_870,
      noAskCents: 38,
      fairNoBps: 4_130,
      edgeBps: 330,
      edgeCents: 3,
      verdict: "cheap",
    },
  ],
  counts: { cheap: 1, fair: 1, expensive: 0, noOffer: 0 },
};
