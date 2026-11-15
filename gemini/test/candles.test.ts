import { describe, expect, it } from "vitest";
import { candlesSchema, normalizeCandles } from "../src/index";
import { fakeClock, fixture, recordedApi, testClient } from "./helpers";

describe("normalizeCandles", () => {
  it("converts prices to integer cents and sorts oldest first", () => {
    const candles = normalizeCandles([
      [7_200_000, 64_919.23, 65_175.76, 64_672.79, 65_111.7, 7.4],
      [3_600_000, 64_800, 65_000.005, 64_700.1, 64_919.23, 1],
    ]);
    expect(candles).toEqual([
      {
        openTimeMs: 3_600_000,
        openCents: 6_480_000,
        highCents: 6_500_001,
        lowCents: 6_470_010,
        closeCents: 6_491_923,
      },
      {
        openTimeMs: 7_200_000,
        openCents: 6_491_923,
        highCents: 6_517_576,
        lowCents: 6_467_279,
        closeCents: 6_511_170,
      },
    ]);
  });

  it("drops rows with unusable prices or repeated timestamps", () => {
    const candles = normalizeCandles([
      [1_000, 1, 1, 1, 1, 0],
      [1_000, 2, 2, 2, 2, 0],
      [2_000, 0, 1, 1, 1, 0],
      [3_000, 1e-7, 1, 1, 1, 0],
      [4_000, -1, 1, 1, 1, 0],
      [4.5, 1, 1, 1, 1, 0],
    ]);
    expect(candles.map((c) => c.openTimeMs)).toEqual([1_000]);
    expect(candles[0]?.closeCents).toBe(100);
  });

  it("parses the recorded hourly candles without gaps", () => {
    const candles = normalizeCandles(candlesSchema.parse(fixture("candles-btcusd-1hr.json")));
    expect(candles).toHaveLength(200);
    for (let i = 1; i < candles.length; i++) {
      expect((candles[i]?.openTimeMs ?? 0) - (candles[i - 1]?.openTimeMs ?? 0)).toBe(3_600_000);
    }
  });
});

describe("getCandles", () => {
  it("fetches the spot symbol's candles once and serves repeats from the cache", async () => {
    const api = recordedApi();
    const clock = fakeClock();
    const client = testClient(api.fetch, clock);
    const first = await client.getCandles("btc", "1hr");
    await client.getCandles("BTC", "1hr");
    expect(api.calls).toEqual(["/v2/candles/btcusd/1hr"]);
    expect(first.at(-1)?.openTimeMs).toBe(Date.parse("2026-11-15T19:00:00Z"));
    clock.now += 300_001;
    await client.getCandles("BTC", "1hr");
    expect(api.calls).toHaveLength(2);
  });

  it("rejects a malformed asset before any request", async () => {
    const api = recordedApi();
    await expect(testClient(api.fetch).getCandles("btc/../x", "1hr")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(api.calls).toHaveLength(0);
  });
});
