/**
 * How a paid hedge signal shapes a plan. Pure and integer-only, like the rest of the planner.
 *
 * The signal carries a model probability for each strike. The planner turns it into the model value of
 * one NO contract and compares that with the limit price it would actually pay (the live NO price
 * plus slippage), not with the price the signal saw, so a stale quote in the signal cannot mislead it.
 */
import type { LadderRung } from "@mandate/gemini";
import type { PaidSignal, PlanSignalUse, SignalRating, SignalRungRating } from "./types";
import { PlannerInputError, requireInteger } from "./units";

export interface SignalContext {
  readonly paid: PaidSignal;
  readonly ignoredBecause: PlanSignalUse["ignoredBecause"];
  /** Model probability of YES by strike, only when the signal is used. */
  readonly modelYesByStrike: ReadonlyMap<number, number>;
  readonly fairBandBps: number;
}

/** Buy order under a binding spend cap: cheapest first, expensive last. */
export const RATING_RANK: Record<SignalRating, number> = { cheap: 0, fair: 1, unrated: 2, expensive: 3 };

/** Validates the signal and decides whether it describes this ladder. */
export function readSignal(
  paid: PaidSignal,
  ladder: { asset: string; eventTicker: string; rungs: readonly LadderRung[] },
): SignalContext {
  if (paid.receiptId.trim() === "") throw new PlannerInputError("signal.receiptId must not be empty");
  if (paid.signal.signalId.trim() === "") throw new PlannerInputError("signal.signalId must not be empty");
  requireInteger(paid.signal.model.fairBandBps, "signal.model.fairBandBps");
  const modelYesByStrike = new Map<number, number>();
  for (const strike of paid.signal.strikes) {
    requireInteger(strike.strikeCents, "signal.strikes[].strikeCents", 1);
    requireInteger(strike.modelYesBps, "signal.strikes[].modelYesBps");
    if (strike.modelYesBps > 10_000) {
      throw new PlannerInputError("signal.strikes[].modelYesBps must be at most 10000");
    }
    modelYesByStrike.set(strike.strikeCents, strike.modelYesBps);
  }
  // A band of zero would call every non-zero edge cheap or expensive; one basis point is the finest band.
  const fairBandBps = Math.max(1, paid.signal.model.fairBandBps);
  const ignore = (ignoredBecause: NonNullable<PlanSignalUse["ignoredBecause"]>): SignalContext => ({
    paid,
    ignoredBecause,
    modelYesByStrike: new Map(),
    fairBandBps,
  });
  if (paid.signal.asset.trim().toUpperCase() !== ladder.asset.trim().toUpperCase())
    return ignore("asset_mismatch");
  if (paid.signal.eventTicker !== ladder.eventTicker) return ignore("event_mismatch");
  if (!ladder.rungs.some((r) => modelYesByStrike.has(r.strikeCents))) return ignore("no_matching_strikes");
  return { paid, ignoredBecause: null, modelYesByStrike, fairBandBps };
}

/** Rates what the plan would pay for one NO contract at this rung against the signal's model. */
export function rateRung(
  signal: SignalContext,
  rung: LadderRung,
  slippageCents: number,
): Omit<SignalRungRating, "boughtHundredths"> {
  const modelYesBps = signal.modelYesByStrike.get(rung.strikeCents);
  const modelNoBps = modelYesBps === undefined ? null : 10_000 - modelYesBps;
  const priced = rung.noBuyCents !== null && rung.noBuyCents >= 1 && rung.noBuyCents <= 99;
  const limitPriceCents =
    priced && rung.noBuyCents !== null ? Math.min(99, rung.noBuyCents + slippageCents) : null;
  if (modelNoBps === null || limitPriceCents === null || rung.marketState !== "open") {
    return {
      instrumentSymbol: rung.instrumentSymbol,
      strikeCents: rung.strikeCents,
      limitPriceCents,
      modelNoBps,
      edgeBps: null,
      rating: "unrated",
    };
  }
  const edgeBps = modelNoBps - limitPriceCents * 100;
  const rating: SignalRating =
    edgeBps >= signal.fairBandBps ? "cheap" : edgeBps <= -signal.fairBandBps ? "expensive" : "fair";
  return {
    instrumentSymbol: rung.instrumentSymbol,
    strikeCents: rung.strikeCents,
    limitPriceCents,
    modelNoBps,
    edgeBps,
    rating,
  };
}

/** "0x1234abcd...ef01": enough of a receipt id to recognise it in a sentence. */
export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
}

/** Stable sort by rating rank: equal ratings keep the staircase order (nearest spot first). */
export function orderBySignal<T>(items: readonly T[], ratingOf: (item: T) => SignalRating): T[] {
  return items
    .map((item, index) => ({ item, index, rank: RATING_RANK[ratingOf(item)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}
