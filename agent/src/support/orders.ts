/**
 * The orders the executor placed on a real venue (issue #117), as the Bot reads them. The executor sizes a
 * Gemini order so its cost and Gemini's fee fit the approved amount, so the order can be for fewer
 * contracts than the amount buys at the limit alone. These helpers say what was placed, never the nominal.
 */
import * as z from "zod";
import {
  type AgentOrder,
  type AnnouncedVenue,
  type FillSource,
  quantityHundredthsFromAmount,
  VENUE_ORDER_STATES,
} from "@mandate/shared";
import type { ToolContext } from "../context";
import { describeFailure } from "./failures";

export const OrderRowSchema = z.object({
  venue: z.literal("gemini"),
  environment: z.enum(["sandbox", "production"]).describe("Which Gemini the order went to"),
  state: z.enum(VENUE_ORDER_STATES).describe("The order's state in the executor's journal"),
  contractsHundredths: z
    .int()
    .describe(
      "Contracts the order was placed for, in hundredths: the most whose cost at the limit plus Gemini's " +
        "fee fit the approved amount. Report this, not what the amount buys at the limit alone",
    ),
  filledContractsHundredths: z.int().describe("Contracts filled so far, in hundredths"),
  feeCents: z
    .int()
    .nullable()
    .describe(
      "Gemini's fee on the fills, estimated from its schedule (no Gemini answer reports it); null until a fill",
    ),
});
export type OrderRow = z.infer<typeof OrderRowSchema>;

export function orderRow(order: AgentOrder): OrderRow {
  return {
    venue: order.venue,
    environment: order.environment,
    state: order.state,
    contractsHundredths: order.quantityHundredths,
    filledContractsHundredths: order.filledHundredths,
    feeCents: order.feeCents,
  };
}

/** The executor's orders by intent id, and the venue it announced for the contract (null before it has). */
export interface OrdersRead {
  byIntent: Map<number, AgentOrder>;
  venue: AnnouncedVenue | null;
  /** Each fill's source as the console labels it, by the venue announced when it was mined; null from an older console. */
  fillSources: Map<number, FillSource> | null;
}

/**
 * The executor's orders from the console, and the venue it announced. Null when there is no console, the
 * console has no such route, or the read failed: a null never reads as "no order was placed".
 */
export async function readOrders(ctx: ToolContext): Promise<OrdersRead | null> {
  if (ctx.console === undefined) return null;
  try {
    const response = await ctx.console.getOrders(ctx.signal);
    return response === null
      ? null
      : {
          byIntent: new Map(response.orders.map((order) => [order.intentId, order])),
          venue: response.venue ?? null,
          fillSources: response.fillSources
            ? new Map(response.fillSources.map((fill) => [fill.intentId, fill.source]))
            : null,
        };
  } catch (error) {
    describeFailure(error, ctx);
    return null;
  }
}

/** "10" or "10.03": contracts from hundredths. */
export function contractsText(hundredths: number): string {
  return hundredths % 100 === 0 ? String(hundredths / 100) : (hundredths / 100).toFixed(2);
}

/** Contracts the amount buys at the limit alone, in hundredths; null when either is not a valid value. */
export function nominalHundredths(amountCents: number | null, limitPrice: number | null): number | null {
  if (amountCents === null || limitPrice === null) return null;
  try {
    return quantityHundredthsFromAmount(amountCents, limitPrice);
  } catch {
    return null;
  }
}

/**
 * One sentence on the order placed: " Placed 10 contracts on Gemini's sandbox, not the 10.03 the amount
 * buys at the limit, so the cost and Gemini's fee fit it." The second clause only when they differ.
 */
export function orderSentence(
  order: OrderRow,
  amountCents: number | null,
  limitPrice: number | null,
): string {
  const where = `Gemini's ${order.environment}`;
  const nominal = nominalHundredths(amountCents, limitPrice);
  const sized =
    nominal !== null && nominal > order.contractsHundredths
      ? `, not the ${contractsText(nominal)} the amount buys at the limit, so the cost and Gemini's fee fit it`
      : "";
  return ` Placed ${contractsText(order.contractsHundredths)} contracts on ${where}${sized}.`;
}
