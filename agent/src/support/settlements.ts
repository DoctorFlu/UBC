/**
 * What filled positions paid when their markets resolved (issue #92), as the Bot reads it. The executor
 * signs each settlement and the console stores it, because the Policy contract can record only one result
 * per intent (the fill). These helpers read the console's list, never guess one, and say it plainly.
 */
import * as z from "zod";
import { formatCents, type Settlement, settlementTotals, type StoredSettlement } from "@mandate/shared";
import type { ToolContext } from "../context";
import { describeFailure } from "./failures";

export const SettlementRowSchema = z.object({
  eventTicker: z.string().describe("The ladder (event) the position was on"),
  expiresAt: z.string(),
  resolution: z.enum(["yes", "no"]).describe("How Gemini resolved the contract"),
  costCents: z.int().describe("What the position cost: the fill"),
  payoutCents: z.int().describe("What it paid at settlement: $1 per contract on the winning side"),
  pnlCents: z.int().describe("payoutCents - costCents"),
  resolvedAt: z.string().describe("When Gemini published the outcome"),
});
export type SettlementRow = z.infer<typeof SettlementRowSchema>;

export const SettlementTotalsSchema = z.object({
  positions: z.int(),
  costCents: z.int(),
  payoutCents: z.int(),
  pnlCents: z.int(),
});

export const LadderSettlementSchema = SettlementTotalsSchema.extend({
  eventTicker: z.string(),
  expiresAt: z.string(),
});
export type LadderSettlement = z.infer<typeof LadderSettlementSchema>;

export function settlementRow(doc: Settlement): SettlementRow {
  return {
    eventTicker: doc.eventTicker,
    expiresAt: doc.expiresAt,
    resolution: doc.resolution,
    costCents: doc.costCents,
    payoutCents: doc.payoutCents,
    pnlCents: doc.pnlCents,
    resolvedAt: doc.resolvedAt,
  };
}

/**
 * The console's settlements, or null when it cannot say: no console configured, a console without the
 * route, or a failed read. A null never reads as "nothing settled".
 */
export async function readSettlements(ctx: ToolContext): Promise<StoredSettlement[] | null> {
  if (ctx.console === undefined) return null;
  try {
    const response = await ctx.console.getSettlements(ctx.signal);
    return response === null ? null : response.settlements;
  } catch (error) {
    describeFailure(error, ctx);
    return null;
  }
}

/** Settled positions grouped by ladder, the latest expiry first. */
export function settledLadders(settlements: readonly StoredSettlement[]): LadderSettlement[] {
  const byTicker = new Map<string, Settlement[]>();
  for (const { document } of settlements) {
    byTicker.set(document.eventTicker, [...(byTicker.get(document.eventTicker) ?? []), document]);
  }
  return [...byTicker]
    .map(([eventTicker, docs]) => ({
      eventTicker,
      expiresAt:
        docs
          .map((doc) => doc.expiresAt)
          .sort()
          .at(-1) ?? "",
      ...settlementTotals(docs),
    }))
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt) || a.eventTicker.localeCompare(b.eventTicker));
}

/** "cost $34.00, paid $40.00, net +$6.00" */
export function moneyLine(totals: { costCents: number; payoutCents: number; pnlCents: number }): string {
  const net = totals.pnlCents > 0 ? `+${formatCents(totals.pnlCents)}` : formatCents(totals.pnlCents);
  return `cost ${formatCents(totals.costCents)}, paid ${formatCents(totals.payoutCents)}, net ${net}`;
}

/** "Ladder BTC2611202200 (expired 2026-11-20T22:00:00.000Z) settled: 2 positions, cost ..., paid ..., net ...." */
export function ladderSentence(ladder: LadderSettlement): string {
  const count = `${ladder.positions} ${ladder.positions === 1 ? "position" : "positions"}`;
  return `Ladder ${ladder.eventTicker} (expired ${ladder.expiresAt}) settled: ${count}, ${moneyLine(ladder)}.`;
}
