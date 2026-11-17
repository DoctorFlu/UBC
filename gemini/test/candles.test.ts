import { describe, expect, it } from "vitest";
import { candlesSchema, countMissingCandles, normalizeCandles } from "../src/index";
import { fakeClock, fixture, json, recordedApi, routedFetch, testClient } from "./helpers";

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

  describe("when Gemini answers with candles missing inside the series (issue #98)", () => {
    // Recorded 2026-11-17 04:14 UTC: 14 hours missing, then the same hours complete five seconds later.
    const gapped = () => fixture("candles-btcusd-1hr-gap.json");
    const healed = () => fixture("candles-btcusd-1hr-healed.json");
    const HOUR = 3_600_000;

    /** Answers candle requests with `bodies` in turn (the last repeats); `null` is a 503. */
    function candleApi(bodies: unknown[]) {
      let answered = 0;
      return routedFetch([
        [
          "/v2/candles/btcusd/1hr",
          () => {
            const body = bodies[Math.min(answered, bodies.length - 1)];
            answered += 1;
            return body === null ? json({ error: "unavailable" }, 503) : json(body);
          },
        ],
      ]);
    }

    it("counts the missing candles inside a series only", () => {
      const series = normalizeCandles(candlesSchema.parse(gapped()));
      expect(countMissingCandles(series, HOUR)).toBe(14);
      expect(countMissingCandles(normalizeCandles(candlesSchema.parse(healed())), HOUR)).toBe(0);
      // A series that starts late or ends early is shorter, not gapped.
      expect(countMissingCandles(series.slice(-6), HOUR)).toBe(0);
      expect(countMissingCandles([], HOUR)).toBe(0);
    });

    it("asks once more after a pause and keeps the healed answer", async () => {
      const api = candleApi([gapped(), healed()]);
      const clock = fakeClock();
      const candles = await testClient(api.fetch, clock).getCandles("BTC", "1hr");
      expect(api.calls).toEqual(["/v2/candles/btcusd/1hr", "/v2/candles/btcusd/1hr"]);
      expect(clock.sleeps).toEqual([1_000]);
      expect(candles).toHaveLength(254);
      expect(countMissingCandles(candles, HOUR)).toBe(0);
    });

    it("returns the gap as it is when it stays, and caches it like any answer", async () => {
      const api = candleApi([gapped()]);
      const clock = fakeClock();
      const client = testClient(api.fetch, clock);
      const candles = await client.getCandles("BTC", "1hr");
      expect(candles).toHaveLength(240);
      expect(countMissingCandles(candles, HOUR)).toBe(14);
      await client.getCandles("BTC", "1hr");
      expect(api.calls).toHaveLength(2);
    });

    it("keeps the answer that misses fewer candles", async () => {
      const worse = (gapped() as unknown[]).filter((_, i) => i !== 3);
      const api = candleApi([gapped(), worse]);
      const candles = await testClient(api.fetch).getCandles("BTC", "1hr");
      expect(countMissingCandles(candles, HOUR)).toBe(14);
    });

    it("keeps the first answer when the second request fails", async () => {
      const api = candleApi([gapped(), null]);
      const candles = await testClient(api.fetch, fakeClock(), { maxRetries: 1 }).getCandles("BTC", "1hr");
      expect(api.calls).toHaveLength(3);
      expect(countMissingCandles(candles, HOUR)).toBe(14);
    });

    it("spends tokens from the same bucket as every other request", async () => {
      const api = candleApi([gapped(), healed()]);
      const clock = fakeClock();
      const client = testClient(api.fetch, clock, {
        rateLimit: { capacity: 1, refillPerMinute: 60 },
        candleGapRetryDelayMs: 0,
      });
      await client.getCandles("BTC", "1hr");
      // The bucket held one token; the retry waited a second for the next.
      expect(clock.sleeps).toEqual([0, 1_000]);
    });
  });

  it("rejects a malformed asset before any request", async () => {
    const api = recordedApi();
    await expect(testClient(api.fetch).getCandles("btc/../x", "1hr")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(api.calls).toHaveLength(0);
  });
});
