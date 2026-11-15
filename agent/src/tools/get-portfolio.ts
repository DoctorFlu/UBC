import * as z from "zod";
import { formatUsd, HOLDING_SCALE, parseHoldingUnits } from "@mandate/planner";
import { ok, reason, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { untrusted, UntrustedTextSchema } from "../mcp/untrusted";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { capList } from "../support/format";

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
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    const empty = { holdings: null, updatedAt: null, truncated: false };
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
        structured: { ...v, holdings, updatedAt: response.updatedAt, truncated },
        summary: summarizeVerdict(v),
      };
    }
    const v = ok([], { actor: "agent", hint: "Call get_ladder for the asset to protect, then plan_hedge." });
    const lines = holdings.map(
      (h) => `${h.quantity} ${h.asset}${h.valueCents === null ? "" : ` (about ${formatUsd(h.valueCents)})`}`,
    );
    return {
      structured: { ...v, holdings, updatedAt: response.updatedAt, truncated },
      summary: `Holdings: ${lines.join(", ")}${truncated ? `, and ${response.holdings.length - items.length} more` : ""}.`,
    };
  },
});
