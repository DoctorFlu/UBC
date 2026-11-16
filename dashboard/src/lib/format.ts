/**
 * Money and percent formatters.
 *
 * Money enters as integer cents (number or bigint) and leaves as an exact string. No floating
 * point touches an amount: a fractional or unsafe number throws instead of silently rounding.
 * Negative values use the true minus sign (U+2212) so columns of tabular figures stay aligned.
 */

const MINUS = "−";

export type SignDisplay = "auto" | "always" | "never";

export interface MoneyOptions {
  /** "auto": minus only when negative. "always": plus or minus (zero gets no sign). "never": absolute value. */
  sign?: SignDisplay;
  /** Drop ".00" when the amount is a whole number of dollars. */
  trimWholeCents?: boolean;
}

function toBigInt(value: number | bigint, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be an integer within the safe range, got ${String(value)}`);
  }
  return BigInt(value);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function signPrefix(negative: boolean, isZero: boolean, sign: SignDisplay): string {
  if (sign === "never" || isZero) return "";
  if (negative) return MINUS;
  return sign === "always" ? "+" : "";
}

/** 123456 -> "$1,234.56"; -5 -> "−$0.05"; 0 -> "$0.00". */
export function formatUsdCents(cents: number | bigint, options: MoneyOptions = {}): string {
  const { sign = "auto", trimWholeCents = false } = options;
  const value = toBigInt(cents, "cents");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = groupThousands((abs / 100n).toString());
  const remainder = (abs % 100n).toString().padStart(2, "0");
  const fraction = trimWholeCents && remainder === "00" ? "" : `.${remainder}`;
  return `${signPrefix(negative, value === 0n, sign)}$${dollars}${fraction}`;
}

/**
 * Parses a typed dollar amount into integer cents without floating point: "75" -> 7500,
 * "1,250.5" -> 125050, "$0.05" -> 5. Returns null for anything that is not a plain non-negative
 * amount with at most two decimals, so a form can say exactly what to fix.
 */
export function parseUsdToCents(input: string): number | null {
  const match = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const whole = (match[1] ?? "").replaceAll(",", "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

/** A signed change in money, for deltas: 1250 -> "+$12.50", -350 -> "−$3.50", 0 -> "$0.00". */
export function formatUsdCentsDelta(cents: number | bigint): string {
  return formatUsdCents(cents, { sign: "always" });
}

/**
 * A prediction-market contract price, quoted in whole cents between 0 and 100: 37 -> "37¢".
 * Prices are integers by construction on Gemini's binary contracts.
 */
export function formatContractPrice(cents: number): string {
  const value = toBigInt(cents, "price");
  if (value < 0n || value > 100n) throw new RangeError(`contract price must be 0 to 100 cents, got ${cents}`);
  return `${value.toString()}¢`;
}

export interface PercentOptions {
  sign?: SignDisplay;
  /** Digits after the decimal point, 0 to 2. Basis points carry two, so 2 is exact. */
  fractionDigits?: 0 | 1 | 2;
}

/**
 * Basis points (integer, 1 bp = 0.01%) to a percent string: 1250 -> "12.50%".
 * With fewer fraction digits the value is rounded half away from zero, on integers.
 */
export function formatPercentBps(bps: number | bigint, options: PercentOptions = {}): string {
  const { sign = "auto", fractionDigits = 2 } = options;
  const value = toBigInt(bps, "basis points");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(2 - fractionDigits);
  const scaled = (abs + divisor / 2n) / divisor;
  const unit = 10n ** BigInt(fractionDigits);
  const whole = groupThousands((scaled / unit).toString());
  const fraction = fractionDigits === 0 ? "" : `.${(scaled % unit).toString().padStart(fractionDigits, "0")}`;
  return `${signPrefix(negative, scaled === 0n, sign)}${whole}${fraction}%`;
}

/**
 * The share of a limit in use, as basis points, rounded down so a meter never shows a limit as
 * reached before it is. Returns 0 for a zero limit.
 */
export function shareBps(used: number | bigint, limit: number | bigint): number {
  const u = toBigInt(used, "used");
  const l = toBigInt(limit, "limit");
  if (l <= 0n) return 0;
  return Number((u * 10_000n) / l);
}

/** Whole contracts with thousands separators: 1200 -> "1,200". */
export function formatCount(count: number | bigint): string {
  const value = toBigInt(count, "count");
  const negative = value < 0n;
  const digits = groupThousands((negative ? -value : value).toString());
  return negative ? `${MINUS}${digits}` : digits;
}

/**
 * Contracts from hundredths, the 0.01-contract steps Gemini trades in: 2930 -> "29.30", 5000 -> "50",
 * 1 -> "0.01", 123456 -> "1,234.56". Exact integer math, at most two decimals, never rounded to whole
 * contracts; a whole number drops its ".00".
 */
export function formatContractsHundredths(hundredths: number | bigint): string {
  const value = toBigInt(hundredths, "contracts");
  if (value < 0n) throw new RangeError(`contracts cannot be negative, got ${value.toString()}`);
  const whole = groupThousands((value / 100n).toString());
  const fraction = value % 100n;
  return fraction === 0n ? whole : `${whole}.${fraction.toString().padStart(2, "0")}`;
}

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Times render in UTC so the server and the browser produce the same string (no hydration
 * mismatch) and so the audit trail lines up with block timestamps.
 */
export function formatTimeUtc(iso: string): string {
  return `${timeFormatter.format(new Date(iso))} UTC`;
}

export function formatDateUtc(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" -> "0xf39F…2266". */
export function shortenHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
