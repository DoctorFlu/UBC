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
  quotes: Pick<LadderQuotes, "asset" | "eventTicker" | "spotCents" | "rungs"> &
    Partial<Pick<LadderQuotes, "elsewhere" | "listed">>;
  intents: readonly IntentView[];
}): CoverNow | null {
  const { quotes } = input;
  // Production's strikes are part of the goal on another venue: without them it cannot be measured.
  if (quotes.elsewhere === null) return null;
  return coverOfPlan({
    plan: input.plan,
    holdingQuantity: input.holdingQuantity,
    ladder: {
      asset: quotes.asset,
      eventTicker: quotes.eventTicker,
      rungs: quotes.rungs,
      listed: quotes.listed ?? true,
    },
    spotCents: quotes.spotCents,
    intents: input.intents,
    elsewhere: new Map((quotes.elsewhere ?? []).map((s) => [s.instrumentSymbol, s.strikeCents])),
  });
}

/** How much of the holding is covered now, in one or two plain sentences. */
export function coverSentence(cover: CoverAssessment, settles: string | null): string {
  const holding = `${cover.holdingQuantity} ${cover.asset}`;
  const floor = cover.floorCents === null ? "its floor" : price(cover.floorCents);
  const below = price(cover.measuredBelowCents ?? cover.floorCents ?? cover.spotCents);
  const when = settles === null ? "" : ` on ${settles}`;
  const ceiling = cover.ceilingCents ?? cover.spotCents;
  const from = ceiling === cover.spotCents ? `today's ${price(ceiling)}` : price(ceiling);
  const spot = `today's ${cover.asset} price of ${price(cover.spotCents)}`;
  // The staircase stops at the lowest strike there is when every strike is above the floor.
  const downTo =
    cover.measuredBelowCents !== null &&
    cover.floorCents !== null &&
    cover.measuredBelowCents > cover.floorCents
      ? `${price(cover.measuredBelowCents)}, the lowest strike there is (your floor ${floor} is below every strike)`
      : floor;
  const loss = `the ${usd(cover.targetPayoutCents)} your ${holding} loses from ${from} down to ${downTo}`;
  const pending = cover.heldByState.awaiting_fill + cover.heldByState.awaiting_owner > 0;
  const held = pending ? "the contracts you hold and your pending orders pay" : "the contracts you hold pay";
  const share = (bps: number | null) => ((bps ?? 0) > 10_000 ? "more than" : `${percent(bps ?? 0)} of`);
  // What a new plan can add on the exchange your orders go to, or why it can add nothing.
  const venue = "the exchange your orders go to";
  const addNothing =
    cover.reason === "ladder_not_listed"
      ? `Nothing more can be bought for it now: ${venue} does not list this ladder.`
      : cover.reason === "no_strike_below_spot"
        ? `Nothing more can be bought for it on this ladder now: ${venue} lists no strike below ${spot}.`
        : cover.reason === "holding_too_small"
          ? `Nothing more can be bought for it: your ${holding} is too small for the smallest contract (0.01).`
          : `Nothing more can be bought for it now: what is missing lies on strikes ${venue} does not list.`;
  const toAdd =
    cover.addablePayoutCents === 0
      ? addNothing
      : cover.addablePayoutCents >= cover.missingPayoutCents
        ? `A new plan buys only the missing ${usd(cover.missingPayoutCents)}.`
        : `A new plan can buy ${usd(cover.addablePayoutCents)} of the missing ${usd(cover.missingPayoutCents)}: ${venue} lists no strike for the rest.`;
  if (cover.belowFloor !== null) {
    const now = `${cover.asset} is at or below the floor: today's ${price(cover.spotCents)} is not above ${floor}.`;
    const protects = `the ${usd(cover.targetPayoutCents)} the goal protects, your ${holding}'s fall from ${price(cover.belowFloor.plannedSpotCents)}, its price when the goal was set, down to ${downTo}`;
    switch (cover.state) {
      case "met":
        return `Covered. ${now} If it settles there${when}, ${held} ${usd(cover.heldPayoutCents)}, ${share(cover.coverBps)} ${protects}.`;
      case "partly_met":
        return `Partly covered. ${now} If it settles there${when}, ${held} ${usd(cover.heldPayoutCents)}, ${percent(cover.coverBps ?? 0)} of ${protects}. Below the floor the goal calls for no more contracts.`;
      default:
        return `Not covered. ${now} No contract you hold pays if it settles there${when}, against ${protects}. Below the floor the goal calls for no more contracts.`;
    }
  }
  switch (cover.state) {
    case "met":
      return `Covered. If ${cover.asset} settles below ${below}${when}, ${held} ${usd(cover.heldPayoutCents)}, ${share(cover.coverBps)} ${loss}. Nothing more is needed.`;
    case "partly_met":
      return `Partly covered. If ${cover.asset} settles below ${below}${when}, ${held} ${usd(cover.heldPayoutCents)}, ${percent(cover.coverBps ?? 0)} of ${loss}. ${toAdd}`;
    case "not_met":
      return `Not covered. No contract you hold pays if ${cover.asset} settles below ${below}${when}, against ${loss}. ${toAdd}`;
    case "nothing_to_cover":
      return ceiling === cover.spotCents
        ? `Nothing to protect now: the floor ${floor} is not below ${spot}, so the goal calls for no contracts.`
        : `Nothing to protect now: the floor ${floor} is not below ${price(ceiling)}, where protection starts, so the goal calls for no contracts.`;
    case "cannot_hedge":
      switch (cover.reason) {
        case "ladder_not_listed":
          return `Not covered, and nothing can be bought for it now: the exchange your orders go to does not list this ladder, and you hold no contract on it.`;
        case "holding_too_small":
          return `Not covered: your ${holding} is too small for the smallest contract (0.01) between ${from} and ${floor}.`;
        case "no_more_strikes":
          return `Not covered. No contract you hold pays if ${cover.asset} settles below ${below}${when}, against ${loss}. ${addNothing}`;
        default:
          return `Not covered, and nothing can be bought for it on this ladder now: it lists no strike below ${spot}, and you hold no contract that pays below it.`;
      }
  }
}
