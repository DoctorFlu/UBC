import "server-only";

import { resolve } from "node:path";

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
}

/** The default data directory: `dashboard/.data`, git-ignored. */
export const DEFAULT_DATA_DIR = resolve(process.cwd(), ".data");

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
  };
}
