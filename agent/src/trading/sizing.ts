/**
 * Sizing of a single trade, shared by `simulate_trade` and `propose_trade` so a preview always
 * equals what would be proposed.
 *
 * Gemini prediction-market contracts are whole: an order is a whole number of $1 contracts at a
 * limit price. A requested amount is therefore rounded down to whole contracts,
 * `contracts = floor(amountCents / limitPrice)`, and the trade proposed is `contracts * limitPrice`
 * cents. Buys and sells follow the same rule: a sell's amount is its size in cents at the limit.
 */
import * as z from "zod";
import { formatCents } from "@mandate/shared";
import { reason, unavailable, type Verdict } from "../mcp/envelope";

export const SizingSchema = z
  .object({
    requestedAmountCents: z.int().describe("The amountCents asked for"),
    contracts: z.int().describe("Whole $1 contracts: floor(requestedAmountCents / limitPrice)"),
    amountCents: z.int().describe("The amount checked and proposed: contracts x limitPrice"),
    roundedDown: z.boolean().describe("True when amountCents is less than requestedAmountCents"),
  })
  .describe("Gemini contracts are whole, so the amount is rounded down to whole contracts");
export type TradeSizing = z.infer<typeof SizingSchema>;

/** Rounds `amountCents` down to whole contracts at `limitPrice` (integer cents, 1 to 99). */
export function sizeTrade(amountCents: number, limitPrice: number): TradeSizing {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0)
    throw new RangeError(`amountCents must be a non-negative integer, got ${amountCents}`);
  if (!Number.isInteger(limitPrice) || limitPrice < 1 || limitPrice > 99)
    throw new RangeError(`limitPrice must be an integer from 1 to 99, got ${limitPrice}`);
  const contracts = Math.floor(amountCents / limitPrice);
  const sized = contracts * limitPrice;
  return {
    requestedAmountCents: amountCents,
    contracts,
    amountCents: sized,
    roundedDown: sized < amountCents,
  };
}

/** The verdict for an amount that buys less than one contract: nothing is checked or proposed. */
export function belowOneContract(limitPrice: number, requestedAmountCents: number): Verdict {
  return unavailable(
    [
      reason(
        "BELOW_ONE_CONTRACT",
        `${formatCents(requestedAmountCents)} is less than one contract at ${limitPrice}c; Gemini contracts are whole.`,
      ),
    ],
    {
      actor: "agent",
      hint: `The smallest trade at ${limitPrice}c is one contract, amountCents ${limitPrice} (${formatCents(limitPrice)}). Tell the owner and use at least that only if they agree.`,
    },
  );
}

/** For a summary, for example `75 contracts; rounded down from $22.00 because contracts are whole`. */
export function describeSizing(sizing: TradeSizing): string {
  const count = `${sizing.contracts} contract${sizing.contracts === 1 ? "" : "s"}`;
  return sizing.roundedDown
    ? `${count}; rounded down from ${formatCents(sizing.requestedAmountCents)} because contracts are whole`
    : count;
}
