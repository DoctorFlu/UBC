/**
 * Builds the hedge signal document from a ladder and recent candles. Pure: no clock, no I/O.
 */
import type { Candle, Ladder } from "@mandate/gemini";
import {
  HEDGE_SIGNAL_VERSION,
  hedgeSignalId,
  type HedgeSignal,
  type HedgeSignalBody,
  type HedgeSignalStrike,
  type SignalErrorCode,
} from "@mandate/shared";
import {
  annualizedVolatilityBps,
  bookState,
  HOUR_MS,
  impliedYesBps,
  judgeProtection,
  probabilityAtOrAboveBps,
  returnWindow,
  type ReturnWindow,
} from "./math";

export interface SignalModelConfig {
  /** Edge, in basis points of a dollar, before a strike is called cheap or expensive. At least 1. */
  fairBandBps: number;
  /**
   * Hours in the volatility window, ending at the newest closed candle (168 is one week), so at most
   * this many hourly returns.
   */
  volWindowHours: number;
  /** Fewest hourly returns in the window that still give an estimate, gaps or not. */
  minVolReturns: number;
  /** A ladder settling sooner than this is refused as expired. */
  minSecondsToExpiry: number;
}

export const DEFAULT_SIGNAL_MODEL: SignalModelConfig = {
  fairBandBps: 200,
  volWindowHours: 168,
  minVolReturns: 24,
  minSecondsToExpiry: 60,
};

export const MODEL_ASSUMPTIONS = [
  "The settlement price is lognormal around today's spot with no drift (zero rates, no carry).",
  "Volatility is the close-to-close realised volatility of hourly Gemini spot candles, annualized over 365 days of trading.",
  "Hours missing from Gemini's candles are left out: no return spans a gap and no candle is filled in, so a gap means fewer returns, as volatility.returns and volatility.missingHours state.",
  "Spot is the Gemini exchange mid, which tracks but is not the index the ladder settles on.",
  "Book prices are the event's best YES bid and ask, the top of each strike's order book.",
  "A NO contract pays one dollar when the settlement price is below the strike; fees are ignored.",
] as const;

export type BuildResult =
  | { ok: true; signal: HedgeSignal }
  | {
      ok: false;
      code: Extract<SignalErrorCode, "no_ladder" | "expired" | "insufficient_history">;
      message: string;
    };

export function buildHedgeSignal(input: {
  ladder: Ladder;
  candles: readonly Candle[];
  nowMs: number;
  config: SignalModelConfig;
}): BuildResult {
  const { ladder, config, nowMs } = input;
  const expiryMs = Date.parse(ladder.expiry);
  const secondsToExpiry = Math.floor((expiryMs - nowMs) / 1000);
  if (Number.isNaN(expiryMs) || secondsToExpiry < Math.max(1, config.minSecondsToExpiry)) {
    return {
      ok: false,
      code: "expired",
      message: `Ladder ${ladder.eventTicker} settles at ${ladder.expiry}, too soon to model; pick a later expiry.`,
    };
  }
  if (ladder.rungs.length === 0) {
    return { ok: false, code: "no_ladder", message: `Event ${ladder.eventTicker} has no strikes.` };
  }

  const window = returnWindow(input.candles, {
    intervalMs: HOUR_MS,
    maxReturns: config.volWindowHours,
    nowMs,
  });
  if (window === null || window.logReturns.length < Math.max(2, config.minVolReturns)) {
    return {
      ok: false,
      code: "insufficient_history",
      message: insufficientHistoryMessage(ladder.asset, window, config.minVolReturns),
    };
  }
  const volatility = {
    annualizedBps: annualizedVolatilityBps(window.logReturns, HOUR_MS),
    returns: window.logReturns.length,
    fromMs: window.fromMs,
    toMs: window.toMs,
    missingHours: window.missingIntervals,
  };

  const spotCents = ladder.spot.midCents;
  const strikes = [...ladder.rungs]
    .sort((a, b) => a.strikeCents - b.strikeCents)
    .map((rung): HedgeSignalStrike => {
      const modelYesBps = probabilityAtOrAboveBps({
        spotCents,
        strikeCents: rung.strikeCents,
        volBps: volatility.annualizedBps,
        secondsToExpiry,
      });
      const fairNoBps = 10_000 - modelYesBps;
      const judgement = judgeProtection({
        noAskCents: rung.noBuyCents,
        fairNoBps,
        fairBandBps: config.fairBandBps,
        open: rung.marketState === "open",
      });
      return {
        strikeCents: rung.strikeCents,
        instrumentSymbol: rung.instrumentSymbol,
        marketState: rung.marketState,
        book: bookState(rung.yesBidCents, rung.yesAskCents),
        yesBidCents: rung.yesBidCents,
        yesAskCents: rung.yesAskCents,
        impliedYesBps: impliedYesBps(rung.yesBidCents, rung.yesAskCents),
        modelYesBps,
        noAskCents: rung.noBuyCents,
        fairNoBps,
        ...judgement,
      };
    });

  const body: HedgeSignalBody = {
    version: HEDGE_SIGNAL_VERSION,
    asset: ladder.asset,
    eventTicker: ladder.eventTicker,
    horizon: ladder.kind,
    expiry: new Date(expiryMs).toISOString(),
    asOf: new Date(nowMs).toISOString(),
    secondsToExpiry,
    spot: { midCents: spotCents, source: `gemini:${ladder.spot.symbol}`, fetchedAt: ladder.spot.fetchedAt },
    volatility: {
      annualizedBps: volatility.annualizedBps,
      method: "close-to-close",
      candle: "1hr",
      returns: volatility.returns,
      from: new Date(volatility.fromMs).toISOString(),
      to: new Date(volatility.toMs).toISOString(),
      missingHours: volatility.missingHours,
      source: `gemini:${ladder.spot.symbol}`,
    },
    model: {
      name: "lognormal-driftless",
      fairBandBps: config.fairBandBps,
      assumptions: [...MODEL_ASSUMPTIONS],
    },
    strikes,
    counts: {
      cheap: strikes.filter((s) => s.verdict === "cheap").length,
      fair: strikes.filter((s) => s.verdict === "fair").length,
      expensive: strikes.filter((s) => s.verdict === "expensive").length,
      noOffer: strikes.filter((s) => s.verdict === "no_offer").length,
    },
  };
  return { ok: true, signal: { ...body, signalId: hedgeSignalId(body) } };
}

/**
 * Why there is no estimate, in numbers: how many hourly returns the window holds, how long it is and how
 * many of its hours Gemini's candles lack.
 */
function insufficientHistoryMessage(asset: string, window: ReturnWindow | null, minReturns: number): string {
  const needed = `At least ${minReturns} are needed to estimate volatility.`;
  if (window === null) return `Gemini returned no closed hourly ${asset} candles. ${needed}`;
  const hours = Math.round((window.toMs - window.fromMs) / HOUR_MS);
  const to = new Date(window.toMs).toISOString();
  const missing =
    window.missingIntervals === 0
      ? ""
      : `; Gemini's candles are missing ${window.missingIntervals} of those hours, and none is filled in`;
  return `Only ${window.logReturns.length} hourly ${asset} returns are available in the ${hours} hours to ${to}${missing}. ${needed}`;
}
