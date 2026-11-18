/**
 * Where each price comes from (18 November 2026): books and listings from the venue's exchange, spot from
 * Gemini production's on every venue, because every ladder settles on production's index. That night the
 * sandbox's own BTC/USD spot sat about $700 below production's, and planning "below spot" on it chose the
 * wrong strikes. These tests go through `createMarketDataClient`, the one factory every service uses.
 */
import { describe, expect, it } from "vitest";
import {
  createMarketDataClient,
  createProductionClient,
  GEMINI_HOSTS,
  GeminiError,
  isGeminiError,
  marketDataSource,
  MAX_LAST_TRADE_AGE_MS,
  spotSourceText,
  type FetchLike,
} from "../src/index";
import { fakeClock, fixture, json } from "./helpers";

/** Production's BTC/USD and the sandbox's own, about $700 apart, as on 18 November 2026. */
const PRODUCTION_SPOT = "64350.00";
const SANDBOX_SPOT = "63650.00";

/** Both exchanges, by host: the recorded ladder on each, and each one's own spot ticker. */
function twoExchanges(options: { productionTicker?: () => Response } = {}) {
  const calls: string[] = [];
  const page = fixture("events-crypto.json");
  const fetchImpl: FetchLike = (input) => {
    const url = new URL(input);
    const where =
      url.origin === GEMINI_HOSTS.production
        ? "production"
        : url.origin === GEMINI_HOSTS.sandbox
          ? "sandbox"
          : url.origin;
    const path = url.pathname + url.search;
    calls.push(`${where} ${path}`);
    if (path.startsWith("/v1/prediction-markets/events?")) return Promise.resolve(json(page));
    if (path === "/v1/prediction-markets/events/BTC2611202200") {
      return Promise.resolve(json(fixture("event-BTC2611202200.json")));
    }
    if (path.startsWith("/v1/book/"))
      return Promise.resolve(json(fixture("book-GEMI-BTC2611202200-HI61000.json")));
    if (path === "/v1/pubticker/btcusd") {
      if (where === "production" && options.productionTicker)
        return Promise.resolve(options.productionTicker());
      const spot = where === "production" ? PRODUCTION_SPOT : SANDBOX_SPOT;
      return Promise.resolve(json({ bid: spot, ask: spot, last: spot }));
    }
    return Promise.resolve(json({ error: "not found" }, 404));
  };
  return { fetch: fetchImpl, calls };
}

const SANDBOX_STACK = marketDataSource({ EXECUTOR_VENUE: "gemini", GEMINI_ENV: "sandbox" });

function sandboxStackClient(api: { fetch: FetchLike }) {
  const clock = fakeClock();
  return createMarketDataClient(SANDBOX_STACK, {
    fetch: api.fetch,
    now: clock.read,
    sleep: clock.sleep,
    random: () => 0.5,
    maxRetries: 0,
  });
}

describe("the market data source", () => {
  it("reads spot from production on every venue, and books from the venue", () => {
    expect(SANDBOX_STACK).toMatchObject({
      environment: "sandbox",
      baseUrl: GEMINI_HOSTS.sandbox,
      productionBaseUrl: GEMINI_HOSTS.production,
    });
    expect(marketDataSource({})).toMatchObject({
      baseUrl: GEMINI_HOSTS.production,
      productionBaseUrl: GEMINI_HOSTS.production,
    });
  });

  it("lets a loopback stand-in in tests serve both", () => {
    const source = marketDataSource({
      EXECUTOR_VENUE: "gemini",
      GEMINI_API_URL: "http://127.0.0.1:8655",
    });
    expect(source).toMatchObject({
      baseUrl: "http://127.0.0.1:8655",
      productionBaseUrl: "http://127.0.0.1:8655",
    });
  });
});

describe("a sandbox stack's ladder (the offset of 18 November 2026)", () => {
  it("measures 'below spot' from production's spot, never the sandbox's own", async () => {
    const api = twoExchanges();
    const ladder = await sandboxStackClient(api).getLadder({
      asset: "BTC",
      horizon: "weekly",
      depth: "below-spot",
    });
    expect(ladder.spot.midCents).toBe(6_435_000);
    // Spot from production; listing, event and books from the sandbox.
    expect(api.calls.filter((c) => c.endsWith("/v1/pubticker/btcusd"))).toEqual([
      "production /v1/pubticker/btcusd",
    ]);
    expect(
      api.calls.filter((c) => !c.endsWith("/pubticker/btcusd")).every((c) => c.startsWith("sandbox ")),
    ).toBe(true);
    // The protective strikes run up to the first one at or above $64,350, which is $64,500. On the
    // sandbox's $63,650 they would have stopped at $64,000.
    const books = api.calls.filter((c) => c.includes("/v1/book/"));
    expect(books.at(-1)).toBe("sandbox /v1/book/GEMI-BTC2611202200-HI64500");
    expect(ladder.rungs.filter((r) => r.depth !== undefined).at(-1)?.strikeCents).toBe(6_450_000);
  });

  it("fails when production's spot cannot be read, and never falls back to the sandbox's ticker", async () => {
    const api = twoExchanges({
      productionTicker: () => json({ error: "An unexpected error occurred" }, 500),
    });
    const error = await sandboxStackClient(api)
      .getLadder({ asset: "BTC", horizon: "weekly" })
      .catch((caught: unknown) => caught);
    expect(isGeminiError(error, "http")).toBe(true);
    expect(api.calls).not.toContain("sandbox /v1/pubticker/btcusd");
  });

  it("reads the production listing of a symbol with the production client", async () => {
    const api = twoExchanges();
    const event = await createProductionClient(SANDBOX_STACK, { fetch: api.fetch, maxRetries: 0 }).getEvent(
      "BTC2611202200",
    );
    expect(event.ticker).toBe("BTC2611202200");
    expect(api.calls).toEqual(["production /v1/prediction-markets/events/BTC2611202200"]);
  });

  it("names the spot it uses in words", () => {
    expect(spotSourceText("btc")).toBe(
      "Gemini's live BTC/USD price, from the exchange whose index the ladder settles on",
    );
  });
});

describe("spot when the spread is wide (Gemini's maintenance, 18 November 2026)", () => {
  // Tonight's ticker: bid $64,242.83, ask $65,249.98 (1.56 %), last $64,321.41 at 05:07:41 UTC.
  const TICKER = { bid: "64242.83000", ask: "65249.98000", last: "64321.41000" };
  const LAST_TRADE_AT = Date.parse("2026-11-18T05:07:41.295Z");

  function client(ticker: object, now: number) {
    const calls: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      const url = new URL(input);
      const path = url.pathname + url.search;
      calls.push(path);
      if (path === "/v1/pubticker/btcusd") return Promise.resolve(json(ticker));
      if (path === "/v1/trades/btcusd?limit_trades=1") {
        return Promise.resolve(
          json([
            {
              timestamp: Math.floor(LAST_TRADE_AT / 1000),
              timestampms: LAST_TRADE_AT,
              tid: 1,
              price: "64321.41",
              amount: "0.00075841",
              exchange: "gemini",
              type: "buy",
            },
          ]),
        );
      }
      return Promise.resolve(json({ error: "not found" }, 404));
    };
    const clock = fakeClock(now);
    return {
      calls,
      gemini: createProductionClient(SANDBOX_STACK, {
        fetch: fetchImpl,
        now: clock.read,
        sleep: clock.sleep,
        maxRetries: 0,
      }),
    };
  }

  it("takes the mid of a normal spread, and asks for no trade", async () => {
    const { gemini, calls } = client({ bid: "64320.00", ask: "64322.00", last: "64321.41" }, LAST_TRADE_AT);
    expect(await gemini.getSpot("BTC")).toMatchObject({ midCents: 6_432_100, basis: "mid", spreadBps: 0 });
    expect(calls).toEqual(["/v1/pubticker/btcusd"]);
  });

  it("takes the last trade instead of a mid hundreds of dollars away, while that trade is recent", async () => {
    const { gemini } = client(TICKER, LAST_TRADE_AT + 2 * 60_000);
    const spot = await gemini.getSpot("BTC");
    // The mid would be $64,746.41, $425 above the last trade.
    expect(spot).toMatchObject({
      midCents: 6_432_141,
      basis: "last",
      spreadBps: 156,
      bidCents: 6_424_283,
      askCents: 6_524_998,
    });
  });

  it("refuses a wide spread whose last trade is old: nothing is measured from it", async () => {
    // 05:31 UTC, 23 minutes after the last trade.
    const { gemini } = client(TICKER, LAST_TRADE_AT + 23 * 60_000 + 19_000);
    const error = await gemini.getSpot("BTC").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeminiError);
    expect(isGeminiError(error, "spot_unavailable")).toBe(true);
    expect((error as GeminiError).message).toBe(
      "Gemini's BTC/USD spot market is not trading normally: the spread is 1.56 % wide, and its last trade was 23 minutes ago.",
    );
  });

  it("allows a last trade exactly at the age limit", async () => {
    const { gemini } = client(TICKER, LAST_TRADE_AT + MAX_LAST_TRADE_AGE_MS);
    expect((await gemini.getSpot("BTC")).basis).toBe("last");
  });
});
