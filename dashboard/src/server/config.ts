import "server-only";

import { resolve } from "node:path";
import { inspect } from "node:util";

import type { EnvVars } from "@mandate/shared/node";

/**
 * Settings of the console backend, read once from the environment. Chain settings (`POLICY_ADDRESS`,
 * `POLICY_DEPLOY_BLOCK`, `ARC_RPC_URL`, `POLICY_DEPLOYMENT_FILE`) are read by `resolvePolicyDeployment` in
 * `@mandate/shared/node`, so every package agrees on which contract is live.
 * Every variable is documented in docs/configuration.md; the account settings in docs/accounts.md.
 */
export type EventSourceKind = "rpc" | "stream";

/** A secret setting. It renders as `[redacted]` in strings, JSON and `util.inspect`; read it with `reveal()`. */
export class SecretSetting {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "SecretSetting [redacted]";
  }
}

export interface AccountsConfig {
  /** Production refuses to start without a master key and refuses open sign-up. */
  mode: "production" | "development";
  /** `invite`: a new workspace needs an invite code. `open`: anyone can create one. */
  signup: "invite" | "open";
  /** The console's origin, from `CONSOLE_URL`: the passkeys' expected origin and every write's `Origin`. */
  origin: string;
  /** The passkeys' relying party id: the origin's host name, or a parent domain of it. */
  rpId: string;
  /** Whether a reverse proxy in front sets `X-Forwarded-For`, so rate limits can key on the client. */
  trustProxy: boolean;
  /** `CONSOLE_MASTER_KEY_FILE`, or null. */
  masterKeyFile: string | null;
  /** `CONSOLE_MASTER_KEY`, or null. */
  masterKey: SecretSetting | null;
}

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
  accounts: AccountsConfig;
}

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

function oneOf<T extends string>(name: string, value: string | null, allowed: readonly T[], fallback: T): T {
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be ${allowed.map((option) => `"${option}"`).join(" or ")}, got "${value}"`);
  }
  return value as T;
}

/** The account settings. Errors name the variable and, for settings that are not secret, the value. */
export function readAccountsConfig(env: EnvVars, publicUrl: string): AccountsConfig {
  const mode = oneOf(
    "CONSOLE_MODE",
    optional(env.CONSOLE_MODE),
    ["production", "development"] as const,
    env.NODE_ENV === "production" ? "production" : "development",
  );
  const signup = oneOf(
    "CONSOLE_SIGNUP",
    optional(env.CONSOLE_SIGNUP),
    ["invite", "open"] as const,
    mode === "production" ? "invite" : "open",
  );
  if (mode === "production" && signup === "open") {
    throw new Error(
      'CONSOLE_SIGNUP="open" is refused in production: anyone could create a workspace. Use "invite".',
    );
  }
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(`CONSOLE_URL must be the console's public URL, got "${publicUrl}"`);
  }
  const rpId = optional(env.CONSOLE_WEBAUTHN_RP_ID)?.toLowerCase() ?? url.hostname;
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new Error(
      `CONSOLE_WEBAUTHN_RP_ID must be the host name of CONSOLE_URL (${url.hostname}) or a parent domain of it, got "${rpId}"`,
    );
  }
  const trustProxy = oneOf(
    "CONSOLE_TRUST_PROXY",
    optional(env.CONSOLE_TRUST_PROXY),
    ["true", "false"],
    "false",
  );
  const masterKey = optional(env.CONSOLE_MASTER_KEY);
  return {
    mode,
    signup,
    origin: url.origin,
    rpId,
    trustProxy: trustProxy === "true",
    masterKeyFile: optional(env.CONSOLE_MASTER_KEY_FILE),
    masterKey: masterKey === null ? null : new SecretSetting(masterKey),
  };
}

export function readConsoleConfig(env: EnvVars = process.env): ConsoleConfig {
  const source = env.CONSOLE_EVENT_SOURCE?.trim() || "rpc";
  if (source !== "rpc" && source !== "stream") {
    throw new Error(`CONSOLE_EVENT_SOURCE must be "rpc" or "stream", got "${source}"`);
  }
  const publicUrl = (optional(env.CONSOLE_URL) ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    dataDir: resolve(optional(env.CONSOLE_DATA_DIR) ?? DEFAULT_DATA_DIR),
    eventSource: source,
    pollIntervalMs: positiveInt("CONSOLE_POLL_INTERVAL_MS", env.CONSOLE_POLL_INTERVAL_MS, 0),
    serviceToken: optional(env.CONSOLE_SERVICE_TOKEN),
    streamSecurityToken: optional(env.QUICKNODE_STREAM_SECURITY_TOKEN),
    publicUrl,
    mcpPublicUrl: optional(env.MCP_PUBLIC_URL),
    accounts: readAccountsConfig(env, publicUrl),
  };
}

/** Settings for tests: a local console in development mode, with `overrides` on top. */
export function testConsoleConfig(
  dataDir: string,
  overrides: Partial<Omit<ConsoleConfig, "accounts">> & { accounts?: Partial<AccountsConfig> } = {},
): ConsoleConfig {
  const publicUrl = overrides.publicUrl ?? "http://console.test";
  const { accounts, ...rest } = overrides;
  return {
    dataDir,
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: null,
    streamSecurityToken: null,
    publicUrl,
    mcpPublicUrl: null,
    ...rest,
    accounts: { ...readAccountsConfig({ CONSOLE_MODE: "development" }, publicUrl), ...accounts },
  };
}
