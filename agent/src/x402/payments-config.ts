/**
 * Settings for paying for signals (issue #21), kept apart from `config.ts` so that file only
 * spreads them in. Every value is parsed once at startup; messages name the variable, never its value.
 */
import { resolve } from "node:path";
import { ARC_TESTNET } from "@mandate/shared";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as z from "zod";
import { Secret } from "../secret";

type Address = `0x${string}`;
type Hex = `0x${string}`;

export const PAYMENTS_ENV_KEYS = [
  "X402_BUYER_PRIVATE_KEY",
  "SIGNAL_DAILY_BUDGET_USDC",
  "SIGNAL_MAX_PRICE_USDC",
  "AGENT_DATA_DIR",
] as const;

export const DEFAULT_SIGNAL_DAILY_BUDGET_USDC = "0.02";
export const DEFAULT_SIGNAL_MAX_PRICE_USDC = "0.005";
/** `<repo root>/.data/agent`, which `.gitignore` already covers. */
export const DEFAULT_AGENT_DATA_DIR = resolve(import.meta.dirname, "..", "..", "..", ".data", "agent");

const usdc = (name: string) =>
  z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, {
    message: `must be a USDC amount with at most 6 decimals for ${name}, for example 0.02`,
  });

/** Fields `config.ts` spreads into its environment schema. */
export const paymentsEnvShape = {
  X402_BUYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, { message: "must be a 0x-prefixed 32-byte hex private key" })
    .optional(),
  SIGNAL_DAILY_BUDGET_USDC: usdc("the daily signal budget").default(DEFAULT_SIGNAL_DAILY_BUDGET_USDC),
  SIGNAL_MAX_PRICE_USDC: usdc("the most one signal may cost").default(DEFAULT_SIGNAL_MAX_PRICE_USDC),
  AGENT_DATA_DIR: z.string().min(1).optional(),
};

export interface PaymentsConfig {
  /** Key of the wallet whose Circle Gateway balance pays for signals. */
  readonly buyerPrivateKey: Secret<Hex> | undefined;
  /** Its public address, derived at startup. */
  readonly buyerAddress: Address | undefined;
  /**
   * Most the signal tool may spend per UTC day, in USDC base units (6 decimals) as a decimal string,
   * so the configuration stays serializable. Use `BigInt(...)` to compute with it.
   */
  readonly dailyBudgetBaseUnits: string;
  /** Most one signal may cost, in USDC base units. Checked before anything is signed. */
  readonly maxPriceBaseUnits: string;
  /** Where the spend ledger and purchased signals are kept. */
  readonly dataDir: string;
}

interface PaymentsVars {
  X402_BUYER_PRIVATE_KEY?: string | undefined;
  SIGNAL_DAILY_BUDGET_USDC: string;
  SIGNAL_MAX_PRICE_USDC: string;
  AGENT_DATA_DIR?: string | undefined;
}

/** Builds the payments settings, or lists what is wrong with them. */
export function paymentsConfigFrom(
  vars: PaymentsVars,
  cwd = process.cwd(),
): { ok: true; config: PaymentsConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const dailyBudget = parseUnits(vars.SIGNAL_DAILY_BUDGET_USDC, ARC_TESTNET.usdcDecimals);
  const maxPrice = parseUnits(vars.SIGNAL_MAX_PRICE_USDC, ARC_TESTNET.usdcDecimals);
  if (maxPrice <= 0n) problems.push("SIGNAL_MAX_PRICE_USDC: must be more than 0");
  if (maxPrice > dailyBudget)
    problems.push("SIGNAL_MAX_PRICE_USDC: must not be more than SIGNAL_DAILY_BUDGET_USDC");

  let buyerAddress: Address | undefined;
  const key = vars.X402_BUYER_PRIVATE_KEY as Hex | undefined;
  if (key !== undefined) {
    try {
      buyerAddress = privateKeyToAccount(key).address;
    } catch {
      problems.push("X402_BUYER_PRIVATE_KEY: is not a valid secp256k1 private key");
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      buyerPrivateKey: key === undefined ? undefined : new Secret(key),
      buyerAddress,
      dailyBudgetBaseUnits: dailyBudget.toString(),
      maxPriceBaseUnits: maxPrice.toString(),
      dataDir: vars.AGENT_DATA_DIR === undefined ? DEFAULT_AGENT_DATA_DIR : resolve(cwd, vars.AGENT_DATA_DIR),
    },
  };
}
