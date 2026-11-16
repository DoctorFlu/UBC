import "server-only";

import { z } from "zod";

/**
 * The parts of `@mandate/planner`'s `HedgePlan` the console draws (#17), checked when the agent posts a
 * plan. The wire contract keeps the plan opaque; this is where the console holds it to the planner's
 * types (a test runs a real `planHedge` result through it). Unknown keys pass, so a newer planner can
 * add fields without breaking the console.
 */
const cents = z.int().nonnegative();
const signedCents = z.int();

const plannedOrderSchema = z.looseObject({
  instrumentSymbol: z.string().min(1),
  strikeCents: cents,
  side: z.literal("no"),
  quantity: z.string(),
  quantityHundredths: z.int().nonnegative(),
  limitPriceCents: cents,
  amountCents: cents,
});

export const hedgePlanSchema = z.looseObject({
  planId: z.string().min(1),
  status: z.enum(["ok", "partial", "empty"]),
  asset: z.string().min(1),
  eventTicker: z.string(),
  expiry: z.string(),
  spotCents: cents,
  holdingQuantity: z.string(),
  ceilingCents: cents.nullable(),
  floorCents: cents.nullable(),
  rungs: z.array(
    z.looseObject({
      instrumentSymbol: z.string().min(1),
      strikeCents: cents,
      limitPriceCents: cents,
      amountCents: cents,
      payoutCents: cents,
      orders: z.array(plannedOrderSchema),
    }),
  ),
  orders: z.array(plannedOrderSchema),
  totals: z.looseObject({
    costCents: cents,
    maxPayoutCents: cents,
    orderCount: z.int().nonnegative(),
  }),
  payoff: z.array(
    z.looseObject({
      priceCents: cents,
      unhedgedPnlCents: signedCents,
      hedgePnlCents: signedCents,
      netPnlCents: signedCents,
    }),
  ),
  warnings: z.array(z.looseObject({ code: z.string(), message: z.string() })),
});
