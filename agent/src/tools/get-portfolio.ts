import * as z from "zod";
import { formatUsd, HOLDING_SCALE, parseHoldingUnits } from "@mandate/planner";
import { settlementTotals } from "@mandate/shared";
import { ok, reason, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { untrusted, UntrustedTextSchema } from "../mcp/untrusted";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { capList } from "../support/format";
import { coverNowRow, CoverNowSchema, coverSentence, readSummary } from "../support/summary";
import {
  LadderSettlementSchema,
  ladderSentence,
  readSettlements,
  settledLadders,
  SettlementTotalsSchema,
} from "../support/settlements";

const MAX_HOLDINGS = 20;
/** Spot prices fetched per call; each is one Gemini request. */
const MAX_PRICED = 6;

const HoldingSchema = z.object({
  asset: z.string(),
  quantity: z.string().describe("Units of the asset, a decimal string"),
  spotCents: z.int().nullable().describe("Gemini spot mid price in cents, or null if unavailable"),
  valueCents: z.int().nullable().describe("quantity x spot, in cents"),
  note: UntrustedTextSchema.nullable().describe("The owner's note from the console"),
});

/** quantity x price in cents, rounded half up, exact for up to 8 decimals. */
export function holdingValueCents(quantity: string, priceCents: number): number {
  const units = parseHoldingUnits(quantity);
  return Number((units * BigInt(priceCents) + HOLDING_SCALE / 2n) / HOLDING_SCALE);
}

export const getPortfolio = defineTool({
  name: "get_portfolio",
  title: "Read the owner's holdings",
  description:
    "Returns the crypto holdings the owner entered in the console (asset and quantity), each valued at Gemini's spot price. These are what a hedge protects. Call it before plan_hedge.",
  inputSchema: z.object({}),
  outputSchema: verdictSchema({
    holdings: z.array(HoldingSchema).nullable(),
    updatedAt: z.string().nullable().describe("When the owner last saved the holdings"),
    truncated: z.boolean(),
    settled: SettlementTotalsSchema.extend({
      lastLadder: LadderSettlementSchema.nullable().describe("The settled ladder with the latest expiry"),
    })
      .nullable()
      .describe(
        "Protection that already settled: every position whose market resolved, as the executor signed it and the console stored it. An expired ladder is over; new protection goes on the next ladder. null when the console cannot say.",
      ),
    cover: z
      .array(CoverNowSchema)
      .nullable()
      .describe(
        "The cover held now against each current goal (the latest plan per asset, on a ladder not expired yet), measured by the console as its Hedge page shows it. Empty when there is no current goal; null when the console cannot say.",
      ),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    const empty = { holdings: null, updatedAt: null, truncated: false, settled: null, cover: null };
    if (ctx.console === undefined) {
      const v = unavailableFor(notConfigured.console());
      return { structured: { ...v, ...empty }, summary: summarizeVerdict(v) };
    }
    let response;
    try {
      response = await ctx.console.getHoldings(ctx.signal);
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, ...empty }, summary: summarizeVerdict(v) };
    }

    const [stored, summary] = await Promise.all([readSettlements(ctx), readSummary(ctx)]);
    const cover = summary === null ? null : summary.cover.map((goal) => coverNowRow(goal, summary));
    const coverText =
      cover === null
        ? " Cover now: the console cannot say right now, so do not report the cover."
        : cover.length === 0
          ? ""
          : ` Cover now: ${cover.map((goal) => coverSentence(goal)).join(" ")}`;
    const settled =
      stored === null
        ? null
        : {
            ...settlementTotals(stored.map((settlement) => settlement.document)),
            lastLadder: settledLadders(stored)[0] ?? null,
          };
    const settledText =
      settled?.lastLadder == null
        ? ""
        : ` Last settled: ${ladderSentence(settled.lastLadder)} That ladder is over; plan new protection on the next one.`;

    const { items, truncated } = capList(response.holdings, MAX_HOLDINGS);
    const markets = ctx.markets;
    const priced = await Promise.all(
      items.map(async (holding, index) => {
        if (markets === undefined || index >= MAX_PRICED) return null;
        try {
          return (await markets.getSpot(holding.asset)).midCents;
        } catch {
          return null;
        }
      }),
    );
    const holdings = items.map((holding, index) => {
      const spotCents = priced[index] ?? null;
      return {
        asset: holding.asset,
        quantity: holding.quantity,
        spotCents,
        valueCents: spotCents === null ? null : holdingValueCents(holding.quantity, spotCents),
        note: holding.note === undefined || holding.note === "" ? null : untrusted(holding.note, "console"),
      };
    });

    if (holdings.length === 0) {
      const v = ok([reason("NO_HOLDINGS", "The owner has not entered any holdings yet.")], {
        actor: "owner",
        hint: "Enter the holdings to protect (asset and quantity) in the console.",
      });
      return {
        structured: { ...v, holdings, updatedAt: response.updatedAt, truncated, settled, cover },
        summary: `${summarizeVerdict(v)}${coverText}${settledText}`,
      };
    }
    const v = ok([], { actor: "agent", hint: "Call get_ladder for the asset to protect, then plan_hedge." });
    const lines = holdings.map(
      (h) => `${h.quantity} ${h.asset}${h.valueCents === null ? "" : ` (about ${formatUsd(h.valueCents)})`}`,
    );
    return {
      structured: { ...v, holdings, updatedAt: response.updatedAt, truncated, settled, cover },
      summary: `Holdings: ${lines.join(", ")}${truncated ? `, and ${response.holdings.length - items.length} more` : ""}.${coverText}${settledText}`,
    };
  },
});
