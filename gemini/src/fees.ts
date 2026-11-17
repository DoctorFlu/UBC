/**
 * Gemini's Prediction Markets fees (https://www.gemini.com/fees/predictions, for contracts listed from
 * 18 March 2026), as published on 17 November 2026:
 *
 *   taker fee = 0.07   x contracts x price x (1 - price)
 *   maker fee = 0.0175 x contracts x price x (1 - price), charged only when a resting order is matched
 *
 * "Fees are rounded up to the next cent." Settlement and cancelling cost nothing. An order that crosses the
 * book pays the taker fee on what matches at once and the maker fee on what matches later. What a buy takes
 * from the account, cost plus the taker fee, is C x P x (1.07 - 0.07 x P) dollars, which grows with P at
 * every price; a buy never fills above its limit, so cost plus the taker fee at the limit is the most it
 * can take. (The fee alone can be larger below the limit, for a limit above 50c, but the cost falls more.)
 *
 * Not stated: whether the rounding applies per fill or per order. This module rounds once per order. If
 * Gemini rounds per fill, every fill after the first can add up to one more cent; no bound holds for every
 * order without knowing how many fills it gets.
 *
 * Gemini also refuses an order whose cost is under one cent ("Order cost must be at least 0.01", seen on the
 * sandbox): the smallest order is 1 contract at 1c.
 */

/** The fee rates in millionths, so the arithmetic stays in integers. */
const RATE_MILLIONTHS = { taker: 70_000n, maker: 17_500n } as const;

export type FeeRole = keyof typeof RATE_MILLIONTHS;

/** Gemini's smallest order cost, in cents. */
export const MIN_ORDER_COST_CENTS = 1;

/**
 * The fee on `contractsHundredths` contracts filled at `priceCents`, in cents, rounded up to the next cent.
 *
 * In dollars: rate x (C / 100) x (P / 100) x ((100 - P) / 100); in cents that is
 * rate x C x P x (100 - P) / 10^4, and with the rate in millionths, / 10^10.
 */
export function predictionFeeCents(contractsHundredths: number, priceCents: number, role: FeeRole): number {
  if (!Number.isSafeInteger(contractsHundredths) || contractsHundredths < 0) {
    throw new RangeError(`contracts must be whole hundredths, got ${String(contractsHundredths)}`);
  }
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99) {
    throw new RangeError(`price must be 1 to 99 cents, got ${String(priceCents)}`);
  }
  const numerator =
    RATE_MILLIONTHS[role] * BigInt(contractsHundredths) * BigInt(priceCents) * BigInt(100 - priceCents);
  const denominator = 10_000_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

/**
 * Gemini's fee on fills, estimated: no API answer reports the fee, so it is computed from the published
 * schedule at the taker rate (the higher one; what matched as a maker paid a quarter of it), for the
 * contracts filled at their average price, rounded up to the next cent once. The average is in
 * ten-thousandths of a dollar (9700 for 97c), as `avgExecutionPrice` can fall between cents.
 *
 * In cents: 0.07 x (H / 100) x (A / 10^4) x ((10^4 - A) / 10^4) x 100 = rate x H x A x (10^4 - A) / 10^14,
 * with the rate in millionths.
 */
export function estimatedFeeCents(filledHundredths: number, averageTenThousandths: number): number {
  if (!Number.isSafeInteger(filledHundredths) || filledHundredths < 0) {
    throw new RangeError(`contracts must be whole hundredths, got ${String(filledHundredths)}`);
  }
  if (
    !Number.isInteger(averageTenThousandths) ||
    averageTenThousandths < 1 ||
    averageTenThousandths > 9_999
  ) {
    throw new RangeError(
      `the average price must be 1 to 9999 ten-thousandths, got ${String(averageTenThousandths)}`,
    );
  }
  const numerator =
    RATE_MILLIONTHS.taker *
    BigInt(filledHundredths) *
    BigInt(averageTenThousandths) *
    BigInt(10_000 - averageTenThousandths);
  const denominator = 100_000_000_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

/** What `contractsHundredths` contracts cost at `priceCents`, in cents, rounded up. */
export function orderCostCents(contractsHundredths: number, priceCents: number): number {
  return Math.ceil((contractsHundredths * priceCents) / 100);
}

/** The most a buy of `contractsHundredths` at the limit `priceCents` can take from the account: cost plus the taker fee. */
export function worstCaseSpendCents(contractsHundredths: number, priceCents: number): number {
  return (
    orderCostCents(contractsHundredths, priceCents) +
    predictionFeeCents(contractsHundredths, priceCents, "taker")
  );
}

/**
 * The largest quantity on the grid (a multiple of `stepHundredths`) whose worst-case spend at the limit
 * fits `amountCents`, or 0 when not even one step does.
 */
export function affordableHundredths(
  amountCents: number,
  priceCents: number,
  stepHundredths: number,
): number {
  // Unrounded, spend in cents is C x P / 100 + 7 x C x P x (100 - P) / 10^6, so this is the most it can be;
  // the two round-ups cost at most two cents, which the loop takes back a step at a time.
  const perHundredthMillionths = 10_000 * priceCents + 7 * priceCents * (100 - priceCents);
  let quantity = Math.floor((amountCents * 1_000_000) / perHundredthMillionths);
  quantity -= quantity % stepHundredths;
  while (quantity > 0 && worstCaseSpendCents(quantity, priceCents) > amountCents) quantity -= stepHundredths;
  return Math.max(quantity, 0);
}
