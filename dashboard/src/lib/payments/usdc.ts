/**
 * USDC amounts as the agent reports them: atomic units (6 decimals) in decimal strings, "1000" being
 * 0.001 USDC. Every operation here is integer math on bigint; a float never touches an amount.
 */
const DECIMALS = 6n;
const SCALE = 10n ** DECIMALS;
const ATOMIC = /^(0|[1-9]\d{0,29})$/;

export function parseUsdcAtomic(value: string): bigint {
  if (!ATOMIC.test(value)) throw new RangeError(`not a USDC atomic amount: ${value}`);
  return BigInt(value);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "1000" -> "0.001 USDC", "20000" -> "0.02 USDC", "4999000" -> "4.999 USDC", "1234500000" ->
 * "1,234.50 USDC". Exact: as many decimals as the amount has, at least two, at most six.
 */
export function formatUsdc(atomic: string | bigint, options: { unit?: boolean } = {}): string {
  const value = typeof atomic === "bigint" ? atomic : parseUsdcAtomic(atomic);
  if (value < 0n) throw new RangeError("USDC amounts here are never negative");
  const whole = group((value / SCALE).toString());
  const fraction = (value % SCALE)
    .toString()
    .padStart(Number(DECIMALS), "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  const text = `${whole}.${fraction}`;
  return options.unit === false ? text : `${text} USDC`;
}

/** Basis points of `used` against `limit`, rounded down, 0 when there is no limit. */
export function usdcShareBps(used: bigint, limit: bigint): number {
  return limit <= 0n ? 0 : Number((used * 10_000n) / limit);
}
