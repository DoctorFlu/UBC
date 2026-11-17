import { type CoverAssessment, coverOfPlan, type HedgePlan, type IntentPosition } from "@mandate/planner";
import type { IntentView } from "@mandate/shared";

import { formatPercentBps, formatUsdCents } from "@/lib/format";
import type { LadderQuotes } from "@/lib/hedge/types";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });
/** Prices in a sentence read best in whole dollars; the amounts paid keep their cents. */
const price = (cents: number) => formatUsdCents(Math.round(cents / 100) * 100, { trimWholeCents: true });
const percent = (bps: number) => formatPercentBps(bps, { fractionDigits: 0 });

export interface CoverNow {
  assessment: CoverAssessment;
  /** The positions counted, one per intent, for the Advanced view. */
  positions: IntentPosition[];
}

/**
 * The cover the owner holds now against the goal of the agent's latest plan, measured with the same
 * planner function the MCP server uses (`docs/cover.md`, `coverOfPlan`): positions from the chain's intents on the
 * plan's ladder, the holding as saved, today's spot, the plan's floor, and its ceiling when the agent
 * set one (a ceiling equal to the plan's spot is the default, which moves with spot).
 */
export function coverNow(input: {
  plan: Pick<
    HedgePlan,
    "asset" | "eventTicker" | "floorCents" | "ceilingCents" | "spotCents" | "holdingQuantity"
  >;
  holdingQuantity: string | null;
  quotes: Pick<LadderQuotes, "asset" | "eventTicker" | "spotCents" | "rungs">;
  intents: readonly IntentView[];
}): CoverNow | null {
  const { quotes } = input;
  return coverOfPlan({
    plan: input.plan,
    holdingQuantity: input.holdingQuantity,
    ladder: { asset: quotes.asset, eventTicker: quotes.eventTicker, rungs: quotes.rungs },
    spotCents: quotes.spotCents,
    intents: input.intents,
  });
}

/** How much of the holding is covered now, in one or two plain sentences. */
export function coverSentence(cover: CoverAssessment, settles: string | null): string {
  const holding = `${cover.holdingQuantity} ${cover.asset}`;
  const floor = price(cover.floorCents ?? 0);
  const below = price(cover.measuredBelowCents ?? cover.floorCents ?? 0);
  const when = settles === null ? "" : ` on ${settles}`;
  const ceiling = cover.ceilingCents ?? cover.spotCents;
  const from = ceiling === cover.spotCents ? `today's ${price(ceiling)}` : price(ceiling);
  const loss = `the ${usd(cover.targetPayoutCents)} your ${holding} loses from ${from} down to ${floor}`;
  const pending = cover.heldByState.awaiting_fill + cover.heldByState.awaiting_owner > 0;
  const held = pending ? "the contracts you hold and your pending orders pay" : "the contracts you hold pay";
  switch (cover.state) {
    case "met":
      return `Covered. If ${cover.asset} settles below ${below}${when}, ${held} ${usd(cover.heldPayoutCents)}, ${(cover.coverBps ?? 0) > 10_000 ? "more than" : `${percent(cover.coverBps ?? 0)} of`} ${loss}. Nothing more is needed.`;
    case "partly_met":
      return `Partly covered. If ${cover.asset} settles below ${below}${when}, ${held} ${usd(cover.heldPayoutCents)}, ${percent(cover.coverBps ?? 0)} of ${loss}. A new plan buys only the missing ${usd(cover.missingPayoutCents)}.`;
    case "not_met":
      return `Not covered. No contract you hold pays if ${cover.asset} settles below ${below}${when}, against ${loss}.`;
    case "nothing_to_cover":
      return `Nothing to cover: ${floor} is not below today's ${cover.asset} price of ${price(cover.spotCents)}, or no strike lies between them.`;
  }
}
