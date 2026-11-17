import "server-only";

import { resolve } from "node:path";

import { WAKE_DEFAULT_DAILY_CAP, WakeTarget } from "@mandate/shared";
import type { EnvVars } from "@mandate/shared/node";

/**
 * Settings of the console backend, read once from the environment. Chain settings (`POLICY_ADDRESS`,
 * `POLICY_DEPLOY_BLOCK`, `ARC_RPC_URL`, `POLICY_DEPLOYMENT_FILE`) are read by `resolvePolicyDeployment` in
 * `@mandate/shared/node`, so every package agrees on which contract is live.
 * Every variable is documented in docs/configuration.md.
 */
export type EventSourceKind = "rpc" | "stream";

export interface ConsoleConfig {
  /** Directory of the console's SQLite file. */
  dataDir: string;
  /** Primary live source. The RPC always backfills; with "stream" it only polls as a slow safety net. */
  eventSource: EventSourceKind;
  /** Poll interval when the RPC is the primary source. */
  pollIntervalMs: number;
  /** Shared secret the MCP server presents, or null when unset (every agent route then answers 503). */
  serviceToken: string | null;
  /** Token QuickNode signs Stream deliveries with, or null when the webhook is disabled. */
  streamSecurityToken: string | null;
  /** Public address of this console, used for links the agent shows the owner. */
  publicUrl: string;
  /** Address of the MCP server as Grok Bot reaches it, shown on the setup page, or null when unknown. */
  mcpPublicUrl: string | null;
  /** Event wake-ups of the Grok Bot routine (issue #40). */
  wake: WakeConfig;
}

export interface WakeConfig {
  /** The routine's webhook, or null when wake-ups are off. Prints as `[redacted]`. */
  target: WakeTarget | null;
  /** Why wake-ups are off, in one sentence that never quotes a value; null when on. */
  offReason: string | null;
  /** Most wake-ups sent per UTC day. */
  dailyCap: number;
  /** Least time between two price checks while the console runs. */
  priceCheckMs: number;
}

/** Five minutes: a goal's floor is far from spot, and each check costs two Gemini requests per goal. */
export const DEFAULT_PRICE_CHECK_MS = 300_000;

/**
 * The default data directory: `dashboard/.data`, git-ignored. `turbopackIgnore` keeps the bundler from
 * tracing the folder as a dependency: under `next dev`, every SQLite write in it would otherwise
 * trigger a rebuild and reload every open page.
 */
export const DEFAULT_DATA_DIR = resolve(/* turbopackIgnore: true */ process.cwd(), ".data");

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds, got "${value}"`);
  }
  return parsed;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function wholeNumber(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${String(min)} to ${String(max)}, got "${value}"`);
  }
  return parsed;
}

/**
 * The webhook's URL and key are secrets: an error or a reason here names the variable, never its value.
 * Both empty is the normal "off"; only one set is off too, and says which is missing.
 */
export function readWakeConfig(env: EnvVars = process.env): WakeConfig {
  const url = optional(env.GROK_WEBHOOK_URL);
  const key = optional(env.GROK_WEBHOOK_KEY);
  const dailyCap = wholeNumber(
    "GROK_WAKE_DAILY_CAP",
    env.GROK_WAKE_DAILY_CAP,
    WAKE_DEFAULT_DAILY_CAP,
    0,
    1_000,
  );
  const priceCheckMs = wholeNumber(
    "GROK_WAKE_PRICE_CHECK_MS",
    env.GROK_WAKE_PRICE_CHECK_MS,
    DEFAULT_PRICE_CHECK_MS,
    1_000,
    86_400_000,
  );
  const off = (offReason: string): WakeConfig => ({ target: null, offReason, dailyCap, priceCheckMs });
  if (url === null && key === null) {
    return off("Set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY on the console to the routine's webhook.");
  }
  if (url === null) return off("GROK_WEBHOOK_KEY is set but GROK_WEBHOOK_URL is empty.");
  if (key === null) return off("GROK_WEBHOOK_URL is set but GROK_WEBHOOK_KEY is empty.");
  try {
    return { target: new WakeTarget(url, key), offReason: null, dailyCap, priceCheckMs };
  } catch {
    return off("GROK_WEBHOOK_URL is not an http or https URL.");
  }
}

export function readConsoleConfig(env: EnvVars = process.env): ConsoleConfig {
  const source = env.CONSOLE_EVENT_SOURCE?.trim() || "rpc";
  if (source !== "rpc" && source !== "stream") {
    throw new Error(`CONSOLE_EVENT_SOURCE must be "rpc" or "stream", got "${source}"`);
  }
  return {
    dataDir: resolve(optional(env.CONSOLE_DATA_DIR) ?? DEFAULT_DATA_DIR),
    eventSource: source,
    pollIntervalMs: positiveInt("CONSOLE_POLL_INTERVAL_MS", env.CONSOLE_POLL_INTERVAL_MS, 0),
    serviceToken: optional(env.CONSOLE_SERVICE_TOKEN),
    streamSecurityToken: optional(env.QUICKNODE_STREAM_SECURITY_TOKEN),
    publicUrl: (optional(env.CONSOLE_URL) ?? "http://localhost:3000").replace(/\/+$/, ""),
    mcpPublicUrl: optional(env.MCP_PUBLIC_URL),
    wake: readWakeConfig(env),
  };
}
