/**
 * The owner's view the console keeps (issue #97): its public address for links, the change requests still
 * waiting for the owner, and the cover held now against each current goal. The console measures cover
 * with the planner on Gemini's quotes, as its Hedge page shows it; these helpers pass it on, never
 * recompute it, and say plainly when the console cannot.
 */
import * as z from "zod";
import { COVER_NOW_STATES, formatCents, type CoverNowView, type SummaryResponse } from "@mandate/shared";
import type { ToolContext } from "../context";
import { describeFailure } from "./failures";

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
  asset: z.string(),
  eventTicker: z.string().describe("The ladder the goal is on"),
  expiresAt: z.string(),
  floorCents: z.int().nullable().describe("The goal: protect the holding below this price"),
  state: z
    .enum(COVER_NOW_STATES)
    .describe(
      "met: covered. partly_met / not_met: positions pay less than the goal calls for. nothing_to_cover: the floor is at or above spot. unavailable: the console cannot measure it now; never report it as covered or not",
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
  link: z.string().describe("The console's Hedge page, which shows the same cover"),
});
export type CoverNowRow = z.infer<typeof CoverNowSchema>;

export function coverNowRow(cover: CoverNowView, summary: SummaryResponse): CoverNowRow {
  return {
    asset: cover.asset,
    eventTicker: cover.eventTicker,
    expiresAt: cover.expiresAt,
    floorCents: cover.floorCents,
    state: cover.state,
    coverBps: cover.coverBps,
    heldPayoutCents: cover.heldPayoutCents,
    heldByState: cover.heldByState,
    targetPayoutCents: cover.targetPayoutCents,
    missingPayoutCents: cover.missingPayoutCents,
    link: consoleLink(summary, "/hedge"),
  };
}

const percent = (bps: number) => `${Math.floor(bps / 100)}%`;

/** "BTC below $63,000.00 on BTC2611272200: covered 100% (positions pay $66.15 of $65.00)." */
export function coverSentence(cover: CoverNowRow): string {
  const goal = `${cover.asset} below ${cover.floorCents === null ? "its floor" : formatCents(cover.floorCents)} on ${cover.eventTicker}`;
  const owner = cover.heldByState?.awaitingOwnerCents ?? 0;
  const pending =
    owner > 0 ? `, ${formatCents(owner)} of it from orders waiting for the owner's approval` : "";
  const paid =
    cover.heldPayoutCents === null || cover.targetPayoutCents === null
      ? ""
      : ` (positions pay ${formatCents(cover.heldPayoutCents)} of ${formatCents(cover.targetPayoutCents)}${pending})`;
  switch (cover.state) {
    case "met":
      // Met is met: a percentage under 100 within the tolerance would read as "not yet fully" (issue #88).
      return `${goal}: covered, the goal is met${paid}.`;
    case "partly_met":
    case "not_met":
      return `${goal}: ${cover.coverBps === null ? "not fully covered" : `covered ${percent(cover.coverBps)}`}${paid}, ${formatCents(cover.missingPayoutCents ?? 0)} missing.`;
    case "nothing_to_cover":
      return `${goal}: nothing to cover, the floor is at or above spot.`;
    case "unavailable":
      return `${goal}: the console cannot measure the cover right now; do not report it as covered or not.`;
  }
}
