import { describe, expect, it } from "vitest";
import {
  bookState,
  classifyEdge,
  HOUR_MS,
  impliedYesBps,
  judgeProtection,
  normalCdf,
  probabilityAtOrAboveBps,
  realizedVolatility,
  roundDiv,
  SECONDS_PER_YEAR,
  toBps,
} from "../src/index";

describe("normalCdf", () => {
  it.each([
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [1.96, 0.9750021048517795],
    [-3, 0.0013498980316301035],
    [3, 0.9986501019683699],
    [-7.5, 3.190891672910947e-14],
    [-8, 6.22096057427178e-16],
  ])("matches the standard normal distribution at %d", (x, expected) => {
    expect(Math.abs(normalCdf(x) - expected)).toBeLessThan(1e-14 + expected * 1e-9);
  });

  it("saturates far in the tails and is symmetric", () => {
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(40)).toBe(1);
    for (const x of [0.1, 0.5, 2, 5]) expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 14);
    expect(normalCdf(Number.NaN)).toBeNaN();
  });
});

describe("probabilityAtOrAboveBps", () => {
  const year = SECONDS_PER_YEAR;

  it("matches N(d2) for known inputs", () => {
    // At the money, 50 % a year, one year: d2 = -0.25, N(-0.25) = 0.40129.
    expect(
      probabilityAtOrAboveBps({
        spotCents: 10_000,
        strikeCents: 10_000,
        volBps: 5_000,
        secondsToExpiry: year,
      }),
    ).toBe(4_013);
    // Spot 10 % above the strike, 20 % a year, a quarter: d2 = (ln 1.1 - 0.005) / 0.1, N = 0.81676.
    expect(
      probabilityAtOrAboveBps({
        spotCents: 11_000,
        strikeCents: 10_000,
        volBps: 2_000,
        secondsToExpiry: year / 4,
      }),
    ).toBe(8_168);
  });

  it("is a step at the strike when the price cannot move", () => {
    const at = (spotCents: number, strikeCents: number, volBps: number, secondsToExpiry: number) =>
      probabilityAtOrAboveBps({ spotCents, strikeCents, volBps, secondsToExpiry });
    // Zero volatility.
    expect(at(6_500_000, 6_400_000, 0, 86_400)).toBe(10_000);
    expect(at(6_400_000, 6_400_000, 0, 86_400)).toBe(10_000);
    expect(at(6_399_999, 6_400_000, 0, 86_400)).toBe(0);
    // Expiry now or in the past.
    expect(at(6_500_000, 6_400_000, 4_000, 0)).toBe(10_000);
    expect(at(6_300_000, 6_400_000, 4_000, -3_600)).toBe(0);
  });

  it("falls as the strike rises and stays within 0 and 10000", () => {
    let previous = 10_001;
    for (let strike = 5_000_000; strike <= 8_000_000; strike += 50_000) {
      const p = probabilityAtOrAboveBps({
        spotCents: 6_500_000,
        strikeCents: strike,
        volBps: 4_000,
        secondsToExpiry: 432_000,
      });
      expect(p).toBeLessThanOrEqual(previous);
      expect(p).toBeGreaterThanOrEqual(0);
      previous = p;
    }
    expect(
      probabilityAtOrAboveBps({
        spotCents: 6_500_000,
        strikeCents: 100,
        volBps: 4_000,
        secondsToExpiry: 3_600,
      }),
    ).toBe(10_000);
    expect(
      probabilityAtOrAboveBps({
        spotCents: 100,
        strikeCents: 6_500_000,
        volBps: 4_000,
        secondsToExpiry: 3_600,
      }),
    ).toBe(0);
  });

  it("refuses non-integer or non-positive prices", () => {
    expect(() =>
      probabilityAtOrAboveBps({ spotCents: 0, strikeCents: 1, volBps: 1, secondsToExpiry: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      probabilityAtOrAboveBps({ spotCents: 1.5, strikeCents: 1, volBps: 1, secondsToExpiry: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      probabilityAtOrAboveBps({ spotCents: 1, strikeCents: 1, volBps: -1, secondsToExpiry: 1 }),
    ).toThrow(RangeError);
  });
});

describe("realizedVolatility", () => {
  const candles = (closes: number[], start = 0) =>
    closes.map((closeCents, i) => ({ openTimeMs: start + i * HOUR_MS, closeCents }));

  it("is the annualized sample standard deviation of hourly log returns", () => {
    // ln(110/100) and ln(99/110): sample sd 0.1418955, times sqrt(8760) = 13.2807 a year.
    const estimate = realizedVolatility(candles([100, 110, 99]), {
      maxReturns: 10,
      minReturns: 2,
      nowMs: 3 * HOUR_MS,
    });
    expect(estimate).toEqual({ annualizedBps: 132_807, returns: 2, fromMs: 0, toMs: 3 * HOUR_MS });
  });

  it("is zero for a price that never changes or grows at a constant rate", () => {
    expect(
      realizedVolatility(candles([500, 500, 500, 500]), { maxReturns: 10, minReturns: 2, nowMs: 4 * HOUR_MS })
        ?.annualizedBps,
    ).toBe(0);
    expect(
      realizedVolatility(candles([100, 200, 400, 800]), { maxReturns: 10, minReturns: 2, nowMs: 4 * HOUR_MS })
        ?.annualizedBps,
    ).toBe(0);
  });

  it("ignores the candle still forming and uses only the newest returns", () => {
    const series = candles([100, 300, 100, 110, 99, 5_000]);
    // The last candle opened at 5h and has not closed at 5.5h; the window keeps two returns: 100 -> 110 -> 99.
    const estimate = realizedVolatility(series, { maxReturns: 2, minReturns: 2, nowMs: 5.5 * HOUR_MS });
    expect(estimate).toEqual({ annualizedBps: 132_807, returns: 2, fromMs: 2 * HOUR_MS, toMs: 5 * HOUR_MS });
  });

  it("stops at a gap instead of treating it as one hour", () => {
    const series = [...candles([100, 400]), ...candles([100, 110, 99], 5 * HOUR_MS)];
    const estimate = realizedVolatility(series, { maxReturns: 10, minReturns: 2, nowMs: 8 * HOUR_MS });
    expect(estimate?.returns).toBe(2);
    expect(estimate?.annualizedBps).toBe(132_807);
  });

  it("accepts candles in any order", () => {
    const series = candles([100, 110, 99]).reverse();
    expect(
      realizedVolatility(series, { maxReturns: 10, minReturns: 2, nowMs: 3 * HOUR_MS })?.annualizedBps,
    ).toBe(132_807);
  });

  it("has no estimate without enough history", () => {
    expect(realizedVolatility([], { maxReturns: 10, minReturns: 2, nowMs: HOUR_MS })).toBeNull();
    expect(
      realizedVolatility(candles([100, 110]), { maxReturns: 10, minReturns: 2, nowMs: 2 * HOUR_MS }),
    ).toBeNull();
    expect(
      realizedVolatility(candles([100, 110, 120]), { maxReturns: 10, minReturns: 2, nowMs: 2 * HOUR_MS }),
    ).toBeNull();
  });
});

describe("book and implied probability", () => {
  it("names the empty side", () => {
    expect(bookState(41, 45)).toBe("two_sided");
    expect(bookState(null, 45)).toBe("no_bids");
    expect(bookState(41, null)).toBe("no_asks");
    expect(bookState(null, null)).toBe("empty");
  });

  it("is the exact mid in basis points, and null unless two-sided", () => {
    expect(impliedYesBps(41, 45)).toBe(4_300);
    expect(impliedYesBps(41, 44)).toBe(4_250);
    expect(impliedYesBps(0, 1)).toBe(50);
    expect(impliedYesBps(null, 45)).toBeNull();
    expect(impliedYesBps(41, null)).toBeNull();
  });
});

describe("judgeProtection", () => {
  const judge = (noAskCents: number | null, open = true) =>
    judgeProtection({ noAskCents, fairNoBps: 3_088, fairBandBps: 200, open });

  it("compares the NO ask with the model's value of NO", () => {
    expect(judge(29)).toEqual({ edgeBps: 188, edgeCents: 2, verdict: "fair" });
    expect(judge(28)).toEqual({ edgeBps: 288, edgeCents: 3, verdict: "cheap" });
    expect(judge(33)).toEqual({ edgeBps: -212, edgeCents: -2, verdict: "expensive" });
  });

  it("counts an edge exactly at the band as cheap or expensive", () => {
    expect(classifyEdge(200, 200)).toBe("cheap");
    expect(classifyEdge(-200, 200)).toBe("expensive");
    expect(classifyEdge(199, 200)).toBe("fair");
    expect(classifyEdge(-199, 200)).toBe("fair");
  });

  it("has nothing to judge without an open market and a NO offer", () => {
    expect(judge(null)).toEqual({ edgeBps: null, edgeCents: null, verdict: "no_offer" });
    expect(judge(29, false)).toEqual({ edgeBps: null, edgeCents: null, verdict: "no_offer" });
  });

  it("needs a band of at least one basis point", () => {
    expect(() => judgeProtection({ noAskCents: 29, fairNoBps: 3_088, fairBandBps: 0, open: true })).toThrow(
      RangeError,
    );
  });
});

describe("integer helpers", () => {
  it("rounds half away from zero", () => {
    expect([150, 149, 50, 49, 0, -49, -50, -149, -150].map((n) => roundDiv(n, 100))).toEqual([
      2, 1, 1, 0, 0, 0, -1, -1, -2,
    ]);
  });

  it("clamps probabilities to basis points", () => {
    expect(toBps(0.40129)).toBe(4_013);
    expect(toBps(1.2)).toBe(10_000);
    expect(toBps(-0.1)).toBe(0);
    expect(() => toBps(Number.NaN)).toThrow(RangeError);
  });
});
