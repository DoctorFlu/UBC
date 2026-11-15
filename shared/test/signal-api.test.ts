import { describe, expect, it } from "vitest";
import {
  HEDGE_SIGNAL_PATH,
  hedgeSignalQuerySchema,
  hedgeSignalSearch,
  signalErrorSchema,
} from "../src/signal-api";

describe("hedge signal API contract", () => {
  it("takes an asset and exactly one way to pick the ladder", () => {
    expect(hedgeSignalQuerySchema.parse({ asset: "btc", horizon: "weekly" })).toEqual({
      asset: "BTC",
      horizon: "weekly",
    });
    expect(hedgeSignalQuerySchema.safeParse({ asset: "BTC" }).success).toBe(false);
    expect(
      hedgeSignalQuerySchema.safeParse({ asset: "BTC", horizon: "weekly", eventTicker: "BTC2611202200" })
        .success,
    ).toBe(false);
    expect(hedgeSignalQuerySchema.safeParse({ asset: "BTC", expiry: "next friday" }).success).toBe(false);
    expect(hedgeSignalQuerySchema.safeParse({ asset: "BTC", horizon: "yearly" }).success).toBe(false);
    expect(hedgeSignalQuerySchema.safeParse({ asset: "B/C", horizon: "daily" }).success).toBe(false);
    expect(hedgeSignalQuerySchema.safeParse({ asset: "BTC", horizon: "daily", extra: "1" }).success).toBe(
      false,
    );
  });

  it("builds the same search string for the same query", () => {
    expect(HEDGE_SIGNAL_PATH).toBe("/v1/signal/hedge");
    expect(hedgeSignalSearch({ asset: "BTC", expiry: "2026-11-20T22:00:00.000Z" })).toBe(
      "?asset=BTC&expiry=2026-11-20T22%3A00%3A00.000Z",
    );
    expect(hedgeSignalSearch({ asset: "ETH", eventTicker: "ETH2611202200" })).toBe(
      "?asset=ETH&eventTicker=ETH2611202200",
    );
  });

  it("keeps refusals in the plain shape x402 clients print", () => {
    expect(signalErrorSchema.parse({ error: "No open BTC ladder.", code: "no_ladder" }).code).toBe(
      "no_ladder",
    );
    expect(signalErrorSchema.safeParse({ error: { code: "no_ladder", message: "x" } }).success).toBe(false);
  });
});
