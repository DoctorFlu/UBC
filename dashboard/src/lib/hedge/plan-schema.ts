import type { HedgePlan } from "@mandate/planner";
import { z } from "zod";

/**
 * The parts of `@mandate/planner`'s `HedgePlan` the console draws (#17), checked when the agent posts a
 * plan and again when the console reads one back. The wire contract keeps the plan opaque; this is where
 * the console holds it to the planner's types (a test runs a real `planHedge` result through it).
 * Unknown keys pass, so a newer planner can add fields without breaking the console.
 */
const cents = z.int().nonnegative();
const signedCents = z.int();
const hundredths = z.int().nonnegative();

const plannedOrderSchema = z.looseObject({
  instrumentSymbol: z.string().min(1),
  strikeCents: cents,
  side: z.literal("no"),
  quantity: z.string(),
  quantityHundredths: hundredths,
  limitPriceCents: cents,
  amountCents: cents,
});

const warningSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  strikesCents: z.array(cents).optional(),
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
      quantity: z.string(),
      quantityHundredths: hundredths,
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
    contractsHundredths: hundredths,
    orderCount: z.int().nonnegative(),
    protectedRange: z.looseObject({ fromCents: cents, toCents: cents }).nullable(),
  }),
  payoff: z.array(
    z.looseObject({
      priceCents: cents,
      unhedgedPnlCents: signedCents,
      hedgePnlCents: signedCents,
      netPnlCents: signedCents,
    }),
  ),
  warnings: z.array(warningSchema),
  uncovered: z
    .array(
      z.looseObject({
        code: z.string(),
        fromCents: cents,
        toCents: cents,
        shortfallCents: cents,
      }),
    )
    .optional(),
  signal: z
    .looseObject({
      receiptId: z.string(),
      signalId: z.string(),
      used: z.boolean(),
      ignoredBecause: z.string().nullable(),
      changedOrders: z.boolean(),
    })
    .optional(),
});

/** The plan as the planner typed it, or null when the stored document is not a plan the console can draw. */
export function readHedgePlan(value: unknown): HedgePlan | null {
  const parsed = hedgePlanSchema.safeParse(value);
  // The schema checks every field the console reads; the rest is the planner's own output, kept as is.
  return parsed.success ? (value as HedgePlan) : null;
}
