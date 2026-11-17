import { candlesSchema, normalizeCandles, type Candle, type Ladder } from "@mandate/gemini";
import { hedgeSignalSchema, verifyHedgeSignal, type HedgeSignal } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { buildHedgeSignal, DEFAULT_SIGNAL_MODEL, HOUR_MS, type BuildResult } from "../src/index";
import {
  GAP_RECORDED_AT,
  gappedCandlesBody,
  healedCandlesBody,
  hourlyCandles,
  RECORDED_AT,
  weeklyLadder,
} from "../src/testing";

function signalOf(result: BuildResult): HedgeSignal {
  if (!result.ok) throw new Error(`expected a signal, got ${result.code}: ${result.message}`);
  return result.signal;
}

const build = (ladder: Ladder = weeklyLadder(), candles = hourlyCandles(), nowMs = RECORDED_AT) =>
  buildHedgeSignal({ ladder, candles, nowMs, config: DEFAULT_SIGNAL_MODEL });

describe("buildHedgeSignal on the recorded weekly BTC ladder", () => {
  const signal = signalOf(build());

  it("produces a valid document whose id matches its content", () => {
    expect(hedgeSignalSchema.parse(signal)).toEqual(signal);
    expect(verifyHedgeSignal(signal)).toBe(true);
    expect(verifyHedgeSignal({ ...signal, asOf: "2026-11-15T20:19:01.000Z" })).toBe(false);
    expect(signal).toMatchObject({
      version: 1,
      asset: "BTC",
      eventTicker: "BTC2611202200",
      horizon: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      asOf: "2026-11-15T20:19:00.000Z",
      secondsToExpiry: 438_060,
      spot: { midCents: 6_471_001, source: "gemini:btcusd" },
      volatility: {
        method: "close-to-close",
        candle: "1hr",
        returns: 168,
        from: "2026-11-08T19:00:00.000Z",
        to: "2026-11-15T20:00:00.000Z",
        missingHours: 0,
      },
      model: { name: "lognormal-driftless", fairBandBps: 200 },
    });
  });

  it("is deterministic", () => {
    expect(signalOf(build())).toEqual(signal);
  });

  it("estimates a plausible annualized volatility for BTC", () => {
    expect(signal.volatility.annualizedBps).toBeGreaterThan(1_500);
    expect(signal.volatility.annualizedBps).toBeLessThan(15_000);
  });

  it("covers every strike, lowest first, with probabilities that fall as the strike rises", () => {
    expect(signal.strikes).toHaveLength(21);
    const strikes = signal.strikes.map((s) => s.strikeCents);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    for (let i = 1; i < signal.strikes.length; i++) {
      expect(signal.strikes[i]?.modelYesBps).toBeLessThanOrEqual(signal.strikes[i - 1]?.modelYesBps ?? 0);
    }
  });

  it("reads each strike's book, implied mid and protection edge in integers", () => {
    const at64k = signal.strikes.find((s) => s.strikeCents === 6_400_000);
    expect(at64k).toMatchObject({
      instrumentSymbol: "GEMI-BTC2611202200-HI64000",
      marketState: "open",
      book: "two_sided",
      yesBidCents: 57,
      yesAskCents: 67,
      impliedYesBps: 6_200,
      noAskCents: 43,
    });
    for (const s of signal.strikes) {
      expect(s.fairNoBps).toBe(10_000 - s.modelYesBps);
      if (s.noAskCents !== null) expect(s.edgeBps).toBe(s.fairNoBps - s.noAskCents * 100);
      for (const value of [s.modelYesBps, s.fairNoBps, s.edgeBps, s.edgeCents, s.impliedYesBps]) {
        if (value !== null) expect(Number.isInteger(value)).toBe(true);
      }
    }
    const { counts } = signal;
    expect(counts.cheap + counts.fair + counts.expensive + counts.noOffer).toBe(21);
    expect(counts.cheap).toBe(signal.strikes.filter((s) => s.verdict === "cheap").length);
  });
});

describe("buildHedgeSignal edge cases", () => {
  it("says which side of a book is empty and does not judge a missing NO offer", () => {
    const ladder = weeklyLadder();
    const [first, second, ...rest] = ladder.rungs;
    if (first === undefined || second === undefined) throw new Error("fixture too short");
    const emptied = {
      ...ladder,
      rungs: [
        { ...first, yesBidCents: null, yesAskCents: null, noBuyCents: null, noSellCents: null },
        { ...second, yesAskCents: null },
        ...rest,
      ],
    };
    const signal = signalOf(build(emptied));
    expect(signal.strikes[0]).toMatchObject({
      book: "empty",
      impliedYesBps: null,
      noAskCents: null,
      edgeBps: null,
      edgeCents: null,
      verdict: "no_offer",
    });
    expect(signal.strikes[1]).toMatchObject({ book: "no_asks", impliedYesBps: null });
    expect(signal.strikes[1]?.verdict).not.toBe("no_offer");
    expect(signal.counts.noOffer).toBeGreaterThanOrEqual(1);
  });

  it("does not judge a strike whose market is not open", () => {
    const ladder = weeklyLadder();
    const [first, ...rest] = ladder.rungs;
    if (first === undefined) throw new Error("fixture too short");
    const signal = signalOf(build({ ...ladder, rungs: [{ ...first, marketState: "closed" }, ...rest] }));
    expect(signal.strikes[0]).toMatchObject({ marketState: "closed", verdict: "no_offer", edgeBps: null });
  });

  it("handles a ladder with a single strike", () => {
    const ladder = weeklyLadder();
    const only = ladder.rungs.find((r) => r.strikeCents === 6_500_000);
    if (only === undefined) throw new Error("fixture has no $65,000 strike");
    const signal = signalOf(build({ ...ladder, rungs: [only] }));
    expect(signal.strikes).toHaveLength(1);
    expect(signal.strikes[0]?.strikeCents).toBe(6_500_000);
    expect(verifyHedgeSignal(signal)).toBe(true);
  });

  it("models a flat market with zero volatility as a step at spot", () => {
    const flat = hourlyCandles().map((c) => ({ ...c, closeCents: 6_471_001 }));
    const signal = signalOf(build(weeklyLadder(), flat));
    expect(signal.volatility.annualizedBps).toBe(0);
    for (const s of signal.strikes) {
      expect(s.modelYesBps).toBe(s.strikeCents <= 6_471_001 ? 10_000 : 0);
    }
  });

  it("refuses a ladder that has expired or is about to", () => {
    const after = build(weeklyLadder(), hourlyCandles(), Date.parse("2026-11-20T22:00:00Z") + 1);
    expect(after).toMatchObject({ ok: false, code: "expired" });
    const tooSoon = build(weeklyLadder(), hourlyCandles(), Date.parse("2026-11-20T21:59:30Z"));
    expect(tooSoon).toMatchObject({ ok: false, code: "expired" });
  });

  it("refuses when there is too little price history, and says how little", () => {
    const recent = hourlyCandles().slice(-10);
    expect(build(weeklyLadder(), recent)).toEqual({
      ok: false,
      code: "insufficient_history",
      message:
        "Only 9 hourly BTC returns are available in the 10 hours to 2026-11-15T20:00:00.000Z. At least 24 are needed to estimate volatility.",
    });
    expect(build(weeklyLadder(), [])).toEqual({
      ok: false,
      code: "insufficient_history",
      message: "Gemini returned no closed hourly BTC candles. At least 24 are needed to estimate volatility.",
    });
  });

  it("refuses a ladder with no strikes", () => {
    expect(build({ ...weeklyLadder(), rungs: [] })).toMatchObject({ ok: false, code: "no_ladder" });
  });

  it("uses the newest closed candles only", () => {
    const candles = hourlyCandles();
    const last = candles.at(-1);
    if (last === undefined) throw new Error("no candles");
    // A wild candle that has not closed yet must not move the estimate.
    const forming = { ...last, openTimeMs: last.openTimeMs + HOUR_MS, closeCents: last.closeCents * 2 };
    const withForming = signalOf(build(weeklyLadder(), [...candles, forming]));
    expect(withForming.volatility).toEqual(signalOf(build()).volatility);
  });
});

describe("buildHedgeSignal on Gemini's candles with a gap (issue #98)", () => {
  // Recorded 2026-11-17 04:14 UTC: one answer lacked 2026-11-16 08:00 to 21:00, the next had them all.
  const gapped = normalizeCandles(candlesSchema.parse(gappedCandlesBody()));
  const healed = normalizeCandles(candlesSchema.parse(healedCandlesBody()));
  const at = (candles: Candle[]) => build(weeklyLadder(), candles, GAP_RECORDED_AT);

  it("records a gap of missing rows, the other rows unchanged", () => {
    const byTime = new Map(healed.map((c) => [c.openTimeMs, c]));
    expect(healed.length - gapped.length).toBe(14);
    for (const candle of gapped) expect(byTime.get(candle.openTimeMs)).toEqual(candle);
  });

  it("uses the full week when the data has no gap", () => {
    expect(signalOf(at(healed)).volatility).toMatchObject({
      returns: 168,
      from: "2026-11-10T03:00:00.000Z",
      to: "2026-11-17T04:00:00.000Z",
      missingHours: 0,
    });
  });

  it("estimates over the hours that exist and says how many are missing", () => {
    const signal = signalOf(at(gapped));
    expect(verifyHedgeSignal(signal)).toBe(true);
    // The same week: 14 missing hours remove 15 returns (one per missing hour, plus the one after the gap).
    expect(signal.volatility).toMatchObject({
      returns: 153,
      from: "2026-11-10T03:00:00.000Z",
      to: "2026-11-17T04:00:00.000Z",
      missingHours: 14,
    });
    // Fewer samples of the same week: close to the complete estimate, not equal to it.
    const complete = signalOf(at(healed)).volatility.annualizedBps;
    expect(signal.volatility.annualizedBps).not.toBe(complete);
    expect(Math.abs(signal.volatility.annualizedBps - complete)).toBeLessThan(complete / 5);
  });

  it("refuses with the count, the window and the missing hours when the gap leaves too little", () => {
    // The newest 20 candles Gemini sent: 6 after the gap and 14 before it.
    expect(at(gapped.slice(-20))).toEqual({
      ok: false,
      code: "insufficient_history",
      message:
        "Only 18 hourly BTC returns are available in the 34 hours to 2026-11-17T04:00:00.000Z; Gemini's candles are missing 14 of those hours, and none is filled in. At least 24 are needed to estimate volatility.",
    });
  });
});
