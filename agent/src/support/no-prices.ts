/**
 * The honest answer for a ladder nobody quotes. Gemini's sandbox (the market data the stack reads when the
 * executor trades there) has a test market maker that quotes only some ladders, and not all the time: on
 * 17 November 2026 its daily, weekly and month-end BTC books were empty while an hourly one was quoted. A
 * plan on such a ladder is empty for one reason only, which the agent should say first and plainly, not
 * as a list of skipped strikes.
 */
import type { GeminiEnvironment, Ladder } from "@mandate/gemini";
import { reason, type Reason } from "../mcp/envelope";

export const NO_PRICES = "NO_PRICES";

/** How many of the ladder's open strikes someone sells NO on now. */
export function pricedRungCount(ladder: Ladder): number {
  return ladder.rungs.filter((rung) => rung.noBuyCents !== null).length;
}

/** A `NO_PRICES` reason when no strike on the ladder has a NO offer, otherwise null. */
export function noPricesReason(ladder: Ladder, environment: GeminiEnvironment): Reason | null {
  if (ladder.rungs.length === 0 || pricedRungCount(ladder) > 0) return null;
  const strikes = `${ladder.rungs.length.toString()} strike${ladder.rungs.length === 1 ? "" : "s"}`;
  return reason(
    NO_PRICES,
    environment === "sandbox"
      ? `No one offers NO on any of the ${strikes} of ${ladder.eventTicker} on Gemini's sandbox right now: its order books are empty, so nothing can be planned or filled on this ladder. The sandbox's test market maker quotes only some ladders, and not all the time.`
      : `No one offers NO on any of the ${strikes} of ${ladder.eventTicker} on Gemini right now, so nothing can be planned on this ladder.`,
  );
}

/** What the agent should do next about a ladder without prices. */
export const NO_PRICES_HINT =
  "Tell the owner that no protection is on sale on this ladder right now. Try another ladder (get_ladder lists them in otherLadders), or the same one later.";
