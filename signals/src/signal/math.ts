/**
 * The hedge signal's maths, as pure functions.
 *
 * Inputs and outputs are integers: prices in cents, probabilities in basis points of one dollar
 * (10000 bps = 100 cents), volatility in basis points per year, time in whole seconds. Floating point
 * is used only inside a calculation (logarithms, square roots, the normal distribution) and every
 * result is rounded to an integer before it leaves this module, so anything hashed or compared later
 * is exact.
 */
import type { BookState, ProtectionVerdict } from "@mandate/shared";

/** A 365-day year: crypto trades every day, so calendar time is the right clock. */
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
export const HOUR_MS = 3_600_000;
const YEAR_MS = SECONDS_PER_YEAR * 1000;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Standard normal cumulative distribution function, accurate to about 1e-14 (Hart 1968, in the form
 * given by G. West, "Better approximations to cumulative normal functions", 2005).
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const exponential = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let numerator = 3.52624965998911e-2 * z + 0.700383064443688;
      numerator = numerator * z + 6.37396220353165;
      numerator = numerator * z + 33.912866078383;
      numerator = numerator * z + 112.079291497871;
      numerator = numerator * z + 221.213596169931;
      numerator = numerator * z + 220.206867912376;
      let denominator = 8.83883476483184e-2 * z + 1.75566716318264;
      denominator = denominator * z + 16.064177579207;
      denominator = denominator * z + 86.7807322029461;
      denominator = denominator * z + 296.564248779674;
      denominator = denominator * z + 637.333633378831;
      denominator = denominator * z + 793.826512519948;
      denominator = denominator * z + 440.413735824752;
      tail = (exponential * numerator) / denominator;
    } else {
      let fraction = z + 0.65;
      fraction = z + 4 / fraction;
      fraction = z + 3 / fraction;
      fraction = z + 2 / fraction;
      fraction = z + 1 / fraction;
      tail = exponential / fraction / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/** Rounds a probability in [0, 1] to whole basis points. */
export function toBps(probability: number): number {
  if (Number.isNaN(probability)) throw new RangeError("probability is NaN");
  return Math.min(10_000, Math.max(0, Math.round(probability * 10_000)));
}

/** `numerator / denominator` rounded half away from zero, for a positive integer denominator. */
export function roundDiv(numerator: number, denominator: number): number {
  requireInteger(numerator, "numerator", Number.MIN_SAFE_INTEGER);
  requireInteger(denominator, "denominator", 1);
  const magnitude = Math.floor((2 * Math.abs(numerator) + denominator) / (2 * denominator));
  return numerator < 0 && magnitude !== 0 ? -magnitude : magnitude;
}

export interface CandleClose {
  /** Start of the candle's interval, Unix milliseconds. */
  openTimeMs: number;
  closeCents: number;
}

export interface ReturnWindowOptions {
  /** Candle width. Default one hour. */
  intervalMs?: number;
  /**
   * Length of the window in candle intervals, ending at the close of the newest closed candle, so at most
   * this many returns.
   */
  maxReturns: number;
  /** Only candles that closed at or before this instant count; the one still forming is ignored. */
  nowMs: number;
}

export interface VolatilityOptions extends ReturnWindowOptions {
  /** Below this many usable returns there is no estimate. At least 2. */
  minReturns: number;
}

/** The log returns inside the volatility window, and how much of the window the data covers. */
export interface ReturnWindow {
  /** Log returns between candles exactly one interval apart, oldest first. None spans a gap. */
  logReturns: number[];
  /** Open time of the first candle in the window. */
  fromMs: number;
  /** Close time of the newest closed candle. */
  toMs: number;
  /** Intervals between `fromMs` and `toMs` that have no candle. */
  missingIntervals: number;
}

export interface VolatilityEstimate {
  /** Annualized close-to-close volatility in basis points per year. */
  annualizedBps: number;
  /** Number of log returns used. */
  returns: number;
  /** Open time of the first candle in the window. */
  fromMs: number;
  /** Close time of the last candle in the window. */
  toMs: number;
  /** Intervals between `fromMs` and `toMs` that had no candle. */
  missingIntervals: number;
}

/**
 * The window a volatility estimate uses: the `maxReturns` intervals up to the close of the newest closed
 * candle (shorter when the series starts later), with the log return of every pair of candles in it that
 * are exactly one interval apart.
 *
 * A missing candle removes the returns on either side of it and nothing else: no return ever spans a gap,
 * because a two-hour move counted as one hour would overstate volatility, and no candle is filled in.
 * Returns null when there is no closed candle at all.
 */
export function returnWindow(
  candles: readonly CandleClose[],
  options: ReturnWindowOptions,
): ReturnWindow | null {
  const intervalMs = options.intervalMs ?? HOUR_MS;
  requireInteger(intervalMs, "intervalMs", 1);
  requireInteger(options.maxReturns, "maxReturns", 2);
  const closed = candles
    .filter((c) => c.openTimeMs + intervalMs <= options.nowMs && c.closeCents > 0)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const newest = closed.at(-1);
  if (newest === undefined) return null;
  const windowStart = newest.openTimeMs - options.maxReturns * intervalMs;
  const inWindow = closed.filter((c) => c.openTimeMs >= windowStart);
  const first = inWindow[0] ?? newest;

  const logReturns: number[] = [];
  let missingIntervals = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const previous = inWindow[i - 1];
    const current = inWindow[i];
    if (previous === undefined || current === undefined) continue;
    const step = current.openTimeMs - previous.openTimeMs;
    if (step === intervalMs) {
      logReturns.push(Math.log(current.closeCents / previous.closeCents));
    } else {
      missingIntervals += Math.max(0, Math.round(step / intervalMs) - 1);
    }
  }
  return { logReturns, fromMs: first.openTimeMs, toMs: newest.openTimeMs + intervalMs, missingIntervals };
}

/**
 * Annualized volatility in basis points from log returns over intervals `intervalMs` wide: their sample
 * standard deviation (n - 1) times the square root of the number of intervals in a year. Needs at least
 * two returns.
 */
export function annualizedVolatilityBps(logReturns: readonly number[], intervalMs: number = HOUR_MS): number {
  requireInteger(intervalMs, "intervalMs", 1);
  if (logReturns.length < 2) throw new RangeError("annualizedVolatilityBps needs at least two returns");
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.round(Math.sqrt(variance * (YEAR_MS / intervalMs)) * 10_000);
}

/**
 * Close-to-close realised volatility over `returnWindow`: the sample standard deviation of the log
 * returns between adjacent closed candles in the window, annualized by the square root of the number
 * of intervals in a year. Each return is a real one-interval move, so the hourly variance they estimate
 * is unbiased by gaps; a gap only leaves fewer of them, which the estimate reports.
 * Returns null when fewer than `minReturns` returns are available.
 */
export function realizedVolatility(
  candles: readonly CandleClose[],
  options: VolatilityOptions,
): VolatilityEstimate | null {
  requireInteger(options.minReturns, "minReturns", 2);
  const window = returnWindow(candles, options);
  if (window === null || window.logReturns.length < options.minReturns) return null;
  return {
    annualizedBps: annualizedVolatilityBps(window.logReturns, options.intervalMs ?? HOUR_MS),
    returns: window.logReturns.length,
    fromMs: window.fromMs,
    toMs: window.toMs,
    missingIntervals: window.missingIntervals,
  };
}

export interface DigitalInput {
  spotCents: number;
  strikeCents: number;
  /** Annualized volatility in basis points. */
  volBps: number;
  secondsToExpiry: number;
}

/**
 * Probability that the price finishes at or above the strike, in basis points, if the log price is
 * normal with no drift in the price itself (a martingale, as with zero rates):
 *
 *     P(S_T >= K) = N(d2),   d2 = (ln(S / K) - sigma^2 T / 2) / (sigma sqrt(T))
 *
 * With zero volatility or no time left the price cannot move, so the answer is 10000 when spot is at or
 * above the strike and 0 otherwise.
 */
export function probabilityAtOrAboveBps(input: DigitalInput): number {
  requireInteger(input.spotCents, "spotCents", 1);
  requireInteger(input.strikeCents, "strikeCents", 1);
  requireInteger(input.volBps, "volBps", 0);
  requireInteger(input.secondsToExpiry, "secondsToExpiry", Number.MIN_SAFE_INTEGER);
  if (input.volBps === 0 || input.secondsToExpiry <= 0) {
    return input.spotCents >= input.strikeCents ? 10_000 : 0;
  }
  const sigma = input.volBps / 10_000;
  const years = input.secondsToExpiry / SECONDS_PER_YEAR;
  const spread = sigma * Math.sqrt(years);
  const d2 = (Math.log(input.spotCents / input.strikeCents) - (spread * spread) / 2) / spread;
  return toBps(normalCdf(d2));
}

/** Which sides of a YES book hold orders. */
export function bookState(yesBidCents: number | null, yesAskCents: number | null): BookState {
  if (yesBidCents !== null && yesAskCents !== null) return "two_sided";
  if (yesBidCents === null && yesAskCents === null) return "empty";
  return yesBidCents === null ? "no_bids" : "no_asks";
}

/**
 * Market-implied probability of YES: the mid of the best bid and ask, in basis points. Exact, because
 * (bid + ask) / 2 cents is (bid + ask) x 50 bps. Null unless both sides have orders.
 */
export function impliedYesBps(yesBidCents: number | null, yesAskCents: number | null): number | null {
  if (yesBidCents === null || yesAskCents === null) return null;
  requireInteger(yesBidCents, "yesBidCents", 0);
  requireInteger(yesAskCents, "yesAskCents", 0);
  return Math.min(10_000, (yesBidCents + yesAskCents) * 50);
}

export interface ProtectionJudgement {
  edgeBps: number | null;
  edgeCents: number | null;
  verdict: ProtectionVerdict;
}

/**
 * Judges the price of protection (one NO contract) against the model's value of it.
 * `edgeBps = fairNoBps - noAskCents x 100`, so a positive edge means NO costs less than it is worth.
 * At least `fairBandBps` of edge either way makes it cheap or expensive; anything closer is fair.
 * A closed market or a missing NO offer has no price to judge.
 */
export function judgeProtection(input: {
  noAskCents: number | null;
  fairNoBps: number;
  fairBandBps: number;
  open: boolean;
}): ProtectionJudgement {
  requireInteger(input.fairNoBps, "fairNoBps", 0);
  requireInteger(input.fairBandBps, "fairBandBps", 1);
  if (!input.open || input.noAskCents === null) {
    return { edgeBps: null, edgeCents: null, verdict: "no_offer" };
  }
  requireInteger(input.noAskCents, "noAskCents", 0);
  const edgeBps = input.fairNoBps - input.noAskCents * 100;
  return { edgeBps, edgeCents: roundDiv(edgeBps, 100), verdict: classifyEdge(edgeBps, input.fairBandBps) };
}

/** Cheap at `+band` or more, expensive at `-band` or less, fair in between. `band` is at least 1. */
export function classifyEdge(edgeBps: number, fairBandBps: number): "cheap" | "fair" | "expensive" {
  if (edgeBps >= fairBandBps) return "cheap";
  if (edgeBps <= -fairBandBps) return "expensive";
  return "fair";
}

function requireInteger(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer of at least ${min}`);
  }
}
