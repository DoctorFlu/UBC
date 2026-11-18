/**
 * The mirror maker's settings, from the environment. The maker trades on Gemini's sandbox only: there is
 * no setting that points it anywhere else, and it refuses to start in an environment configured for
 * production at all.
 *
 * GEMINI_MAKER_API_KEY, GEMINI_MAKER_API_SECRET  the maker's own sandbox account (never the executor's).
 * MAKER_KINDS              ladders to quote, from daily, weekly, month-end (default: daily). Never hourly
 *                          or shorter: the sandbox runs a maker of its own there.
 * MAKER_ASSETS             underlyings (default: BTC).
 * MAKER_INTERVAL_MS        time between cycles (default 15000, at least 5000).
 * MAKER_MAX_QUOTE_CONTRACTS  contracts per quote (default 100).
 * MAKER_MAX_QUOTE_USD        cost of one quote if it filled (default 50).
 * MAKER_MAX_RESTING_USD      cost of all quotes together if they filled (default 1000).
 * MAKER_MAX_RUNG_CONTRACTS   contracts held on one contract and outcome before that side stops (default 500).
 * MAKER_MAX_INVENTORY_USD    what everything held may cost before the maker stops quoting (default 2000).
 *
 * Error messages name a setting, never a key's or a secret's value.
 */
import type { GeminiCredentials } from "../private";
import type { LadderKind } from "../types";
import type { MakerLimits } from "./mirror";

export const MAKER_KINDS = ["daily", "weekly", "month-end"] as const satisfies readonly LadderKind[];
export type MakerKind = (typeof MAKER_KINDS)[number];

/** Every client order id the maker sends starts with this, and only those orders are ever cancelled. */
export const MAKER_ORDER_PREFIX = "mk-";

export interface MakerSettings {
  credentials: GeminiCredentials;
  kinds: MakerKind[];
  assets: string[];
  intervalMs: number;
  limits: MakerLimits;
  /** New quotes placed per cycle at most; cancels are never held back. */
  maxPlacementsPerCycle: number;
  /** How often the sandbox's listings are read again. */
  discoveryMs: number;
}

export const MAKER_DEFAULTS = {
  intervalMs: 15_000,
  minIntervalMs: 5_000,
  maxQuoteContracts: 100,
  maxQuoteUsd: 50,
  maxRestingUsd: 1_000,
  maxRungContracts: 500,
  maxInventoryUsd: 2_000,
  closeBeforeMs: 2 * 60_000,
  staleAfterMs: 45_000,
  maxPlacementsPerCycle: 8,
  discoveryMs: 60_000,
} as const;

function positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function list(env: Record<string, string | undefined>, name: string, fallback: string): string[] {
  const raw = env[name]?.trim() || fallback;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) throw new Error(`${name} is empty`);
  return [...new Set(items)];
}

export function makerSettings(env: Record<string, string | undefined>): MakerSettings {
  const environment = env.GEMINI_ENV?.trim().toLowerCase() ?? "";
  if (environment !== "" && environment !== "sandbox") {
    throw new Error(
      `GEMINI_ENV is "${environment}". The mirror maker trades on Gemini's sandbox only and does not start ` +
        "where the stack is set for any other environment.",
    );
  }
  if ((env.GEMINI_LIVE_TRADING?.trim() ?? "") !== "") {
    throw new Error(
      "GEMINI_LIVE_TRADING is set. The mirror maker does not start where live trading is set at all.",
    );
  }
  const apiKey = env.GEMINI_MAKER_API_KEY?.trim() ?? "";
  const apiSecret = env.GEMINI_MAKER_API_SECRET?.trim() ?? "";
  if (apiKey === "" || apiSecret === "") {
    throw new Error(
      "GEMINI_MAKER_API_KEY and GEMINI_MAKER_API_SECRET must both be set: the maker's own sandbox account.",
    );
  }
  if (apiKey === (env.GEMINI_API_KEY?.trim() ?? "")) {
    throw new Error(
      "GEMINI_MAKER_API_KEY is the executor's key (GEMINI_API_KEY). The maker needs an account of its own, so " +
        "that it never trades with or cancels the executor's orders.",
    );
  }
  const kinds = list(env, "MAKER_KINDS", "daily").map((kind) => {
    if (!(MAKER_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`MAKER_KINDS takes ${MAKER_KINDS.join(", ")}; "${kind}" is not one of them`);
    }
    return kind as MakerKind;
  });
  const assets = list(env, "MAKER_ASSETS", "BTC").map((asset) => asset.toUpperCase());
  const intervalMs = positiveNumber(env, "MAKER_INTERVAL_MS", MAKER_DEFAULTS.intervalMs);
  if (intervalMs < MAKER_DEFAULTS.minIntervalMs) {
    throw new Error(`MAKER_INTERVAL_MS must be at least ${String(MAKER_DEFAULTS.minIntervalMs)}`);
  }
  const usd = (name: string, fallback: number) => Math.round(positiveNumber(env, name, fallback) * 100);
  const contracts = (name: string, fallback: number) => Math.floor(positiveNumber(env, name, fallback) * 100);
  return {
    credentials: { apiKey, apiSecret },
    kinds,
    assets,
    intervalMs: Math.floor(intervalMs),
    limits: {
      maxQuoteHundredths: contracts("MAKER_MAX_QUOTE_CONTRACTS", MAKER_DEFAULTS.maxQuoteContracts),
      maxQuoteNotionalCents: usd("MAKER_MAX_QUOTE_USD", MAKER_DEFAULTS.maxQuoteUsd),
      maxRestingNotionalCents: usd("MAKER_MAX_RESTING_USD", MAKER_DEFAULTS.maxRestingUsd),
      maxRungInventoryHundredths: contracts("MAKER_MAX_RUNG_CONTRACTS", MAKER_DEFAULTS.maxRungContracts),
      maxInventoryNotionalCents: usd("MAKER_MAX_INVENTORY_USD", MAKER_DEFAULTS.maxInventoryUsd),
      closeBeforeMs: MAKER_DEFAULTS.closeBeforeMs,
      staleAfterMs: MAKER_DEFAULTS.staleAfterMs,
    },
    maxPlacementsPerCycle: MAKER_DEFAULTS.maxPlacementsPerCycle,
    discoveryMs: MAKER_DEFAULTS.discoveryMs,
  };
}
