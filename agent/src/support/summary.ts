/**
 * The owner's view the console keeps (issue #97): its public address for links, the change requests still
 * waiting for the owner, and the cover held now against each current goal. The console measures cover
 * with the planner on Gemini's quotes, as its Hedge page shows it; these helpers pass it on, never
 * recompute it, and say plainly when the console cannot.
 */
import * as z from "zod";
import {
  COVER_NOW_STATES,
  COVER_REASONS,
  formatCents,
  formatEasternTime,
  goalLabel,
  type CoverNowView,
  type SummaryResponse,
} from "@mandate/shared";
import type { ToolContext } from "../context";
import { describeFailure } from "./failures";
import { DateTextSchema } from "./format";

/**
 * The console's summary, or null when it cannot say: no console configured, a console without the route,
 * or a failed read. A null never reads as "nothing waiting" or "nothing covered".
 */
export async function readSummary(ctx: ToolContext): Promise<SummaryResponse | null> {
  if (ctx.console === undefined) return null;
  try {
    return await ctx.console.getSummary(ctx.signal);
  } catch (error) {
    describeFailure(error, ctx);
    return null;
  }
}

/** A page of the console, for the owner to open. */
export function consoleLink(summary: SummaryResponse, path: string): string {
  return `${summary.consoleUrl}${path}`;
}

export const CoverNowSchema = z.object({
  goal: z
    .string()
    .describe(
      'The goal in the owner\'s words: "BTC, through today, 22:00 UTC" or "BTC, through Fri 20 Nov". Name goals this way, never by ladder ticker alone',
    ),
  asset: z.string(),
  eventTicker: z.string().describe("The ladder the goal is on"),
  expiresAt: z.string(),
  expiresText: DateTextSchema,
  floorCents: z.int().nullable().describe("The goal: protect the holding below this price"),
  state: z
    .enum(COVER_NOW_STATES)
    .describe(
      "met: covered. partly_met / not_met: positions pay less than the goal calls for. With belowFloor set, the price is at or below the floor and the state compares what positions pay if it settles at today's price with the goal as planned. nothing_to_cover: the floor is not below spot and nothing is held, so the goal calls for no contracts now. cannot_hedge: not covered, and nothing can be bought for it now (reason says why). unavailable: the console cannot measure it now; never report it as covered or not",
    ),
  reason: z
    .enum(COVER_REASONS)
    .nullable()
    .describe(
      "For nothing_to_cover and cannot_hedge, why there is no staircase; for partly_met and not_met, why nothing can be added on the exchange that takes this mandate's orders. floor_not_below_ceiling (the floor is not below spot), no_strike_below_spot (that exchange lists no strike below spot), ladder_not_listed (that exchange does not list the ladder), holding_too_small (too small for 0.01 contracts), no_more_strikes (what is missing lies on strikes that exchange does not list). Null otherwise",
    ),
  coverBps: z.int().nullable().describe("held / target; 10000 = 100%"),
  heldPayoutCents: z.int().nullable().describe("What the positions on the ladder pay below the floor"),
  heldByState: z
    .object({
      filledCents: z.int(),
      awaitingFillCents: z.int().describe("Approved, not filled yet"),
      awaitingOwnerCents: z.int().describe("Waiting for the owner's approval: not protection until approved"),
    })
    .nullable()
    .describe("heldPayoutCents split by how far each position has come"),
  targetPayoutCents: z.int().nullable().describe("What the goal calls for there"),
  missingPayoutCents: z.int().nullable().describe("What a new plan would add; 0 when met"),
  belowFloor: z
    .object({
      spotCents: z.int().describe("Today's price, at or below the floor"),
      plannedSpotCents: z.int().describe("The price when the goal was planned"),
      downToCents: z
        .int()
        .describe("Where the goal's protection ends: the floor, or the lowest strike above it"),
    })
    .nullable()
    .describe(
      "Set when the price is at or below the floor and positions are held: heldPayoutCents is what they pay if it settles at today's price, targetPayoutCents what the goal protects from plannedSpotCents down to downToCents. Null otherwise",
    ),
  link: z.string().describe("The console's Hedge page, which shows the same cover"),
});
export type CoverNowRow = z.infer<typeof CoverNowSchema>;

export function coverNowRow(cover: CoverNowView, summary: SummaryResponse, now: number): CoverNowRow {
  return {
    goal: goalLabel(cover.asset, cover.expiresAt, now),
    asset: cover.asset,
    eventTicker: cover.eventTicker,
    expiresAt: cover.expiresAt,
    expiresText: formatEasternTime(cover.expiresAt),
    floorCents: cover.floorCents,
    state: cover.state,
    reason: cover.reason,
    coverBps: cover.coverBps,
    heldPayoutCents: cover.heldPayoutCents,
    heldByState: cover.heldByState,
    targetPayoutCents: cover.targetPayoutCents,
    missingPayoutCents: cover.missingPayoutCents,
    belowFloor:
      cover.belowFloor === null || cover.spotCents === null
        ? null
        : {
            spotCents: cover.spotCents,
            plannedSpotCents: cover.belowFloor.plannedSpotCents,
            downToCents: Math.max(cover.floorCents ?? 0, cover.measuredBelowCents ?? 0),
          },
    link: consoleLink(summary, "/hedge"),
  };
}

const percent = (bps: number) => `${Math.floor(bps / 100)}%`;

const VENUE = "the exchange that takes this mandate's orders";

/** Why nothing can be added to a goal not met, after its shortfall; empty when something can. */
function addNothing(reason: CoverNowRow["reason"]): string {
  switch (reason) {
    case "ladder_not_listed":
      return `; nothing more can be bought for it now: ${VENUE} does not list this ladder`;
    case "no_strike_below_spot":
      return `; nothing more can be bought for it now: ${VENUE} lists no strike below today's price`;
    case "holding_too_small":
      return "; nothing more can be bought for it: the holding is too small for the smallest contract (0.01)";
    case "no_more_strikes":
      return `; nothing more can be bought for it now: what is missing lies on strikes ${VENUE} does not list`;
    default:
      return "";
  }
}

/**
 * "BTC, through Fri 20 Nov (protect below $63,000.00; ladder BTC2611272200, settles Fri Nov 27, 2026, 5:00 PM
 * ET): covered, the goal is met (...)."
 */
export function coverSentence(cover: CoverNowRow): string {
  const goal = `${cover.goal} (protect below ${cover.floorCents === null ? "its floor" : formatCents(cover.floorCents)}; ladder ${cover.eventTicker}, settles ${cover.expiresText})`;
  const owner = cover.heldByState?.awaitingOwnerCents ?? 0;
  const pending =
    owner > 0 ? `, ${formatCents(owner)} of it from orders waiting for the owner's approval` : "";
  const paid =
    cover.heldPayoutCents === null || cover.targetPayoutCents === null
      ? ""
      : ` (positions pay ${formatCents(cover.heldPayoutCents)} of ${formatCents(cover.targetPayoutCents)}${pending})`;
  const below = cover.belowFloor;
  if (below !== null && cover.heldPayoutCents !== null && cover.targetPayoutCents !== null) {
    const now = `${cover.asset} is at or below the floor, at ${formatCents(below.spotCents)}`;
    const against = `against the ${formatCents(cover.targetPayoutCents)} the goal protects from ${formatCents(below.plannedSpotCents)}, the price when it was planned, down to ${formatCents(below.downToCents)}${pending}`;
    const pays = `if it settles there, positions pay ${formatCents(cover.heldPayoutCents)}, ${against}`;
    switch (cover.state) {
      case "met":
        return `${goal}: covered: ${now}; ${pays}.`;
      case "partly_met":
        return `${goal}: covered ${percent(cover.coverBps ?? 0)}: ${now}; ${pays}. Nothing more can be bought for it below the floor.`;
      default:
        return `${goal}: not covered: ${now}; no position held pays if it settles there, ${against}. Nothing more can be bought for it below the floor.`;
    }
  }
  switch (cover.state) {
    case "met":
      // Met is met: a percentage under 100 within the tolerance would read as "not yet fully" (issue #88).
      return `${goal}: covered, the goal is met${paid}.`;
    case "partly_met":
    case "not_met":
      return `${goal}: ${cover.coverBps === null ? "not fully covered" : `covered ${percent(cover.coverBps)}`}${paid}, ${formatCents(cover.missingPayoutCents ?? 0)} missing${addNothing(cover.reason)}.`;
    case "nothing_to_cover":
      return `${goal}: nothing to protect now: the floor is not below today's price, so the goal calls for no contracts.`;
    case "cannot_hedge":
      switch (cover.reason) {
        case "ladder_not_listed":
          return `${goal}: not covered, and nothing can be bought for it now: the exchange that takes this mandate's orders does not list this ladder, and no position is held on it.`;
        case "holding_too_small":
          return `${goal}: not covered: the holding is too small for the smallest contract (0.01).`;
        default:
          return `${goal}: not covered, and nothing can be bought for it on this ladder now: the exchange that takes this mandate's orders lists no strike below today's price, and no position held pays below it.`;
      }
    case "unavailable":
      return `${goal}: the console cannot measure the cover right now; do not report it as covered or not.`;
  }
}
