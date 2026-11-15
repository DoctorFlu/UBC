/**
 * Exact conversion of Gemini's decimal strings into integers.
 *
 * Gemini returns every price and quantity as a decimal string ("0.41", "250.0", "64740.56000").
 * We never turn those into floating-point dollars: prices become integer cents and contract
 * quantities become integer hundredths of a contract (the 0.01 quantity increment).
 */

/** How to treat digits beyond the target precision. */
export type Rounding =
  /** Reject values that are not exactly representable (returns null). */
  | "exact"
  /** Round toward positive infinity (use for prices we pay). */
  | "up"
  /** Round toward negative infinity (use for prices we receive and for available size). */
  | "down"
  /** Round half away from zero (use for reference values such as spot). */
  | "half-up";

const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$/;

/**
 * Parse a decimal string and scale it to an integer with `decimals` fractional digits.
 * Returns null when the input is not a plain decimal, or when `rounding` is "exact" and
 * the value has more precision than `decimals`.
 */
export function scaleDecimal(value: string, decimals: number, rounding: Rounding): bigint | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const dropped = fraction.slice(decimals);
  let magnitude = BigInt(whole + kept);
  const hasRemainder = /[1-9]/.test(dropped);
  if (hasRemainder) {
    if (rounding === "exact") return null;
    const firstDropped = Number(dropped[0]);
    const roundAway =
      rounding === "half-up" ? firstDropped >= 5 : negative ? rounding === "down" : rounding === "up";
    if (roundAway) magnitude += 1n;
  }
  return negative ? -magnitude : magnitude;
}

/** Convert a dollar decimal string to integer cents, or null if it cannot be converted. */
export function toCents(value: string | null | undefined, rounding: Rounding): number | null {
  if (value === null || value === undefined || value === "") return null;
  const scaled = scaleDecimal(value, 2, rounding);
  if (scaled === null) return null;
  const asNumber = Number(scaled);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/** Convert a contract quantity string to integer hundredths of a contract (rounded down). */
export function toHundredths(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const scaled = scaleDecimal(value, 2, "down");
  if (scaled === null || scaled < 0n) return null;
  const asNumber = Number(scaled);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}
