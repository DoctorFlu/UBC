/**
 * The market `dev:propose` uses when it is given none: a strike Gemini lists right now, so the simulated
 * executor, which refuses a market Gemini does not list, can fill it. A hard-coded symbol stops working the
 * moment its ladder settles.
 */
import type { GeminiClient, Ladder, LadderRung } from "@mandate/gemini";

export interface DefaultMarket {
  /** Gemini instrumentSymbol of the picked strike. */
  market: string;
  eventTicker: string;
  /** ISO timestamp the ladder settles at. */
  expiry: string;
  strikeCents: number;
  /** Gemini spot mid the strike was picked against. */
  spotCents: number;
}

/** The asset and ladder the default market comes from. */
export const DEFAULT_MARKET_ASSET = "BTC";
export const DEFAULT_MARKET_HORIZON = "weekly";

/**
 * The open rung whose strike is closest to spot, the lower strike on a tie, or null when no rung is open.
 * At the money is where a weekly ladder trades most, so a default limit price there is plausible.
 */
export function pickAtTheMoneyRung(ladder: Pick<Ladder, "rungs" | "spot">): LadderRung | null {
  const spot = ladder.spot.midCents;
  let best: LadderRung | null = null;
  for (const rung of ladder.rungs) {
    if (rung.marketState !== "open") continue;
    if (best === null) {
      best = rung;
      continue;
    }
    const distance = Math.abs(rung.strikeCents - spot);
    const bestDistance = Math.abs(best.strikeCents - spot);
    if (distance < bestDistance || (distance === bestDistance && rung.strikeCents < best.strikeCents)) {
      best = rung;
    }
  }
  return best;
}

/**
 * Asks Gemini for the soonest open weekly BTC ladder and picks its at-the-money open strike. Throws the
 * client's `GeminiError` when Gemini cannot be reached or lists no open weekly BTC ladder, and an `Error`
 * when the ladder it returns has no open strike.
 */
export async function resolveDefaultMarket(client: Pick<GeminiClient, "getLadder">): Promise<DefaultMarket> {
  const ladder = await client.getLadder({ asset: DEFAULT_MARKET_ASSET, horizon: DEFAULT_MARKET_HORIZON });
  const rung = pickAtTheMoneyRung(ladder);
  if (rung === null) {
    throw new Error(
      `Gemini's ${DEFAULT_MARKET_HORIZON} ${DEFAULT_MARKET_ASSET} ladder ${ladder.eventTicker} has no open strike`,
    );
  }
  return {
    market: rung.instrumentSymbol,
    eventTicker: ladder.eventTicker,
    expiry: ladder.expiry,
    strikeCents: rung.strikeCents,
    spotCents: ladder.spot.midCents,
  };
}
