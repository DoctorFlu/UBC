/**
 * Exact integer arithmetic for the planner.
 *
 * - Prices and money: integer cents (number).
 * - Contract quantities: integer hundredths of a contract (number). One contract pays 100
 *   cents, so a quantity in hundredths is also its payout in cents. Gemini contracts are whole,
 *   so every quantity the planner orders is a multiple of `CONTRACT_HUNDREDTHS`.
 * - Holding quantities: integer units of 1e-8 of the asset (bigint), so products such as
 *   quantity x price never lose precision.
 */
export const HOLDING_DECIMALS = 8;
export const HOLDING_SCALE = 10n ** BigInt(HOLDING_DECIMALS);

export class PlannerInputError extends Error {
  override readonly name = "PlannerInputError";
}

/** Parse a holding quantity into 1e-8 units. Throws on anything not positive and exact to 8 decimals. */
export function parseHoldingUnits(value: string | number): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || value > 1e12) {
      throw new PlannerInputError("Holding quantity must be a positive number");
    }
    text = /e/i.test(String(value)) ? value.toFixed(HOLDING_DECIMALS) : String(value);
  } else {
    text = value.trim();
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new PlannerInputError(`Holding quantity "${text}" is not a plain decimal`);
  const fraction = match[2] ?? "";
  if (fraction.length > HOLDING_DECIMALS && /[1-9]/.test(fraction.slice(HOLDING_DECIMALS))) {
    throw new PlannerInputError(`Holding quantity "${text}" has more than ${HOLDING_DECIMALS} decimals`);
  }
  const units = BigInt((match[1] ?? "0") + fraction.slice(0, HOLDING_DECIMALS).padEnd(HOLDING_DECIMALS, "0"));
  if (units <= 0n) throw new PlannerInputError("Holding quantity must be positive");
  return units;
}

export function formatHoldingUnits(units: bigint): string {
  const whole = units / HOLDING_SCALE;
  const fraction = (units % HOLDING_SCALE).toString().padStart(HOLDING_DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** floor(a / b) for b > 0, correct for negative a. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** ceil(a / b) for b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

/** a / b rounded half away from zero, for b > 0. */
export function roundDiv(a: bigint, b: bigint): bigint {
  const magnitude = (2n * (a < 0n ? -a : a) + b) / (2n * b);
  return a < 0n ? -magnitude : magnitude;
}

/** Holding value change in exact "cent x 1e-8" units: units x priceDeltaCents. */
export function holdingCentsScaled(units: bigint, priceDeltaCents: number): bigint {
  return units * BigInt(priceDeltaCents);
}

/** Holding value change rounded to the cent. */
export function holdingCents(units: bigint, priceDeltaCents: number): number {
  return Number(roundDiv(holdingCentsScaled(units, priceDeltaCents), HOLDING_SCALE));
}

/** ceil(hundredths x priceCents / 100): what an order of that size at that price can cost. */
export function orderAmountCents(hundredths: number, priceCents: number): number {
  return Number(ceilDiv(BigInt(hundredths) * BigInt(priceCents), 100n));
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${(abs % 100).toString().padStart(2, "0")}`;
}

/** Whole-dollar format for strikes and floors, keeping cents only when present. */
export function formatPrice(cents: number): string {
  return cents % 100 === 0 ? formatUsd(cents).slice(0, -3) : formatUsd(cents);
}

/** One whole contract, in hundredths. */
export const CONTRACT_HUNDREDTHS = 100;

/** A contract count for a sentence: "25" for whole contracts, "12.37" otherwise. */
export function formatContractCount(hundredths: number): string {
  return hundredths % CONTRACT_HUNDREDTHS === 0
    ? (hundredths / CONTRACT_HUNDREDTHS).toString()
    : formatContracts(hundredths);
}

export function formatContracts(hundredths: number): string {
  return `${Math.floor(hundredths / 100).toString()}.${(hundredths % 100).toString().padStart(2, "0")}`;
}

export function requireInteger(value: number, name: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new PlannerInputError(`${name} must be an integer of at least ${min.toString()}`);
  }
}
