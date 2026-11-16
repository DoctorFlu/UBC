/**
 * Unit conventions shared by every package.
 *
 * - Money is an integer number of cents (`amountCents`, `budgetCents`, `pnlCents`, ...).
 * - `limitPrice` is cents per one-dollar contract, an integer from 1 to 99.
 * - Order quantity is a number of contracts with at most 2 decimals: `floor2(amountCents / limitPrice)`.
 * - From a quantity, the amount is `ceil(quantity * limitPrice)` cents.
 *
 * Integers are plain JavaScript numbers and must stay within `Number.MAX_SAFE_INTEGER`. An onchain amount or
 * price that is larger decodes to null with its exact value kept in the record's `outOfRange`, never to a
 * rounded or clamped number (see `chainNumber`).
 */

export const MIN_LIMIT_PRICE = 1;
export const MAX_LIMIT_PRICE = 99;

export class UnitError extends Error {
  override name = "UnitError";
}

export function isCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function assertCents(value: number, label = "amount"): void {
  if (!isCents(value))
    throw new UnitError(`${label} must be a non-negative integer number of cents, got ${value}`);
}

export function isValidLimitPrice(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_LIMIT_PRICE && value <= MAX_LIMIT_PRICE;
}

export function assertLimitPrice(value: number): void {
  if (!isValidLimitPrice(value)) {
    throw new UnitError(
      `limitPrice must be an integer from ${MIN_LIMIT_PRICE} to ${MAX_LIMIT_PRICE} cents, got ${value}`,
    );
  }
}

/** Whether an onchain integer fits a JavaScript number exactly. */
export function fitsSafeInteger(value: bigint): boolean {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER);
}

/**
 * Converts an onchain integer to a number, throwing when it does not fit exactly. Only for values the
 * chain itself bounds (block numbers, timestamps, intent ids) or that our own keys write (the rules).
 * Amounts, prices and results that another key writes are decoded with `chainNumber`, never this.
 */
export function toSafeNumber(value: bigint, label = "value"): number {
  if (!fitsSafeInteger(value)) {
    throw new UnitError(`${label} ${value} is outside the safe integer range offchain code supports`);
  }
  return Number(value);
}

/**
 * Decodes an onchain integer that another key wrote, such as an amount or a limit price from the agent
 * key: the number when it fits exactly, otherwise null, with the exact value recorded in `outOfRange`
 * under `field`. It never throws and never clamps, so one hostile value cannot stop a reader and cannot
 * be read as a real amount.
 */
export function chainNumber(value: bigint, field: string, outOfRange: Record<string, string>): number | null {
  if (fitsSafeInteger(value)) return Number(value);
  outOfRange[field] = value.toString();
  return null;
}

/** Number of contracts, in hundredths, that `amountCents` buys at `limitPrice` (floored). */
export function quantityHundredthsFromAmount(amountCents: number, limitPrice: number): number {
  assertCents(amountCents);
  assertLimitPrice(limitPrice);
  return Math.floor((amountCents * 100) / limitPrice);
}

/** Number of contracts `amountCents` buys at `limitPrice`, floored to 2 decimals. */
export function quantityFromAmount(amountCents: number, limitPrice: number): number {
  return quantityHundredthsFromAmount(amountCents, limitPrice) / 100;
}

/** Cents needed to buy `quantity` contracts at `limitPrice`, rounded up. `quantity` has at most 2 decimals. */
export function amountFromQuantity(quantity: number, limitPrice: number): number {
  assertLimitPrice(limitPrice);
  const hundredths = Math.round(quantity * 100);
  if (!Number.isSafeInteger(hundredths) || hundredths < 0 || Math.abs(hundredths - quantity * 100) > 1e-6) {
    throw new UnitError(`quantity must be a non-negative number with at most 2 decimals, got ${quantity}`);
  }
  return Math.ceil((hundredths * limitPrice) / 100);
}

/** Quantity as the decimal string Gemini's order API expects, for example `"15.38"`. */
export function formatQuantity(quantity: number): string {
  return quantity.toFixed(2);
}

/** `limitPrice` in cents to Gemini's dollar price string, for example `65` to `"0.65"`. */
export function limitPriceToDollars(limitPrice: number): string {
  assertLimitPrice(limitPrice);
  return (limitPrice / 100).toFixed(2);
}

/** Gemini's dollar price (for example `"0.65"`) to a `limitPrice` in cents. Throws when not a whole cent. */
export function dollarsToLimitPrice(price: string | number): number {
  const cents = parseCentsExact(price);
  assertLimitPrice(cents);
  return cents;
}

/** Dollars (number or string such as `"12.34"` or `"$12.34"`) to integer cents. Throws on fractional cents. */
export function dollarsToCents(dollars: string | number): number {
  const cents = parseCentsExact(dollars);
  if (!Number.isSafeInteger(cents)) throw new UnitError(`amount ${dollars} is too large`);
  return cents;
}

function parseCentsExact(value: string | number): number {
  const text = (typeof value === "number" ? String(value) : value.trim()).replace(/^\$/, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new UnitError(`not a dollar amount with at most 2 decimals: ${String(value)}`);
  const [, sign, whole = "0", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}

/** Integer cents to a dollar string, for example `1234` to `"$12.34"` and `-150` to `"-$1.50"`. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new UnitError(`cents must be a safe integer, got ${cents}`);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${dollars}.${rest}`;
}
