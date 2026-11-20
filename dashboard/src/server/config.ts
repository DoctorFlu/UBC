import "server-only";

import { resolve } from "node:path";
import { inspect } from "node:util";

import { WAKE_DEFAULT_DAILY_CAP, WakeTarget } from "@mandate/shared";
import type { EnvVars } from "@mandate/shared/node";

import { SANDBOX_LIQUIDITY, type SandboxLiquidity } from "@/lib/live/types";

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
  /** Production refuses to start without a master key. */
  mode: "production" | "development";
  /** `open` (the default): anyone can create a workspace. `invite`: a new workspace needs an invite code. */
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
  /**
   * Where an MCP server on this machine listens (`MCP_HOST` and `MCP_PORT`, the settings it reads too), for
   * Setup to ask while `MCP_PUBLIC_URL` is not set; null when it is, or in tests.
   */
  mcpLocalUrl: string | null;
  /**
   * How this deployment gets liquidity on Gemini's sandbox, as its operator declares it (`SANDBOX_LIQUIDITY`):
   * "mirror-maker" when the mirror maker runs for it (docs/gemini-venue.md), else null. The console never
   * infers it; the venue badge's details describe the maker only when it is declared.
   */
  sandboxLiquidity: SandboxLiquidity | null;
  accounts: AccountsConfig;
  /** Event wake-ups of the Grok Bot routine (issue #40). */
  wake: WakeConfig;
  /** Several mandates per workspace (#95). */
  mandates: MandatesConfig;
}

export interface MandatesConfig {
  /**
   * Most mandates a workspace may have, the first included (`CONSOLE_MANDATES_PER_WORKSPACE`). Each mandate
   * has exactly one agent, so this bounds the agents too; on the demo chain it also bounds the contracts
   * the console deploys and pays for.
   */
  maxPerWorkspace: number;
  /**
   * Who deploys a new mandate's contract (`CONSOLE_MANDATE_DEPLOYER`): `server` on the demo chain, `wallet`
   * (the owner's own) on Arc. Null picks by network: the local or demo chain is `server`, Arc is `wallet`.
   */
  deployer: "server" | "wallet" | null;
  /**
   * The executor a new contract names (`CONSOLE_MANDATE_EXECUTOR`). Null: the executor of the server's own
   * contract, so one executor serves every mandate.
   */
  executor: `0x${string}` | null;
  /** Where the compiled Policy contracts are (`CONSOLE_POLICY_ARTIFACTS_DIR`); null finds `devchain/out`. */
  artifactsDir: string | null;
}

export const DEFAULT_MANDATES_PER_WORKSPACE = 5;

export function readMandatesConfig(env: EnvVars = process.env): MandatesConfig {
  const executor = optional(env.CONSOLE_MANDATE_EXECUTOR);
  if (executor !== null && !/^0x[0-9a-fA-F]{40}$/.test(executor)) {
    throw new Error(`CONSOLE_MANDATE_EXECUTOR must be an address (0x and 40 hex digits), got "${executor}"`);
  }
  const deployer = optional(env.CONSOLE_MANDATE_DEPLOYER);
  return {
    maxPerWorkspace: wholeNumber(
      "CONSOLE_MANDATES_PER_WORKSPACE",
      env.CONSOLE_MANDATES_PER_WORKSPACE,
      DEFAULT_MANDATES_PER_WORKSPACE,
      1,
      100,
    ),
    deployer:
      deployer === null
        ? null
        : oneOf("CONSOLE_MANDATE_DEPLOYER", deployer, ["server", "wallet"] as const, "server"),
    executor: executor as `0x${string}` | null,
    artifactsDir: optional(env.CONSOLE_POLICY_ARTIFACTS_DIR),
  };
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
  /**
   * `GROK_WAKE_TEST_CLOCK=on`: wake-ups run on a clock the end-to-end tests move forward through
   * `POST /api/dev/wake-clock`, so a debounce window ends when a test says so. Refused in production.
   */
  testClock: boolean;
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
  const signup = oneOf("CONSOLE_SIGNUP", optional(env.CONSOLE_SIGNUP), ["invite", "open"] as const, "open");
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
  const testClock =
    oneOf("GROK_WAKE_TEST_CLOCK", optional(env.GROK_WAKE_TEST_CLOCK), ["on", "off"] as const, "off") === "on";
  const off = (offReason: string): WakeConfig => ({
    target: null,
    offReason,
    dailyCap,
    priceCheckMs,
    testClock,
  });
  if (url === null && key === null) {
    return off("Set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY on the console to the routine's webhook.");
  }
  if (url === null) return off("GROK_WEBHOOK_KEY is set but GROK_WEBHOOK_URL is empty.");
  if (key === null) return off("GROK_WEBHOOK_URL is set but GROK_WEBHOOK_KEY is empty.");
  try {
    return { target: new WakeTarget(url, key), offReason: null, dailyCap, priceCheckMs, testClock };
  } catch {
    return off("GROK_WEBHOOK_URL is not an http or https URL.");
  }
}

export function readConsoleConfig(env: EnvVars = process.env): ConsoleConfig {
  const source = env.CONSOLE_EVENT_SOURCE?.trim() || "rpc";
  if (source !== "rpc" && source !== "stream") {
    throw new Error(`CONSOLE_EVENT_SOURCE must be "rpc" or "stream", got "${source}"`);
  }
  const publicUrl = (optional(env.CONSOLE_URL) ?? "http://localhost:3000").replace(/\/+$/, "");
  const accounts = readAccountsConfig(env, publicUrl);
  const wake = readWakeConfig(env);
  if (accounts.mode === "production" && wake.testClock) {
    throw new Error(
      "GROK_WAKE_TEST_CLOCK=on is refused in production: anyone with the service token could move the wake-ups' clock.",
    );
  }
  return {
    dataDir: resolve(optional(env.CONSOLE_DATA_DIR) ?? DEFAULT_DATA_DIR),
    eventSource: source,
    pollIntervalMs: positiveInt("CONSOLE_POLL_INTERVAL_MS", env.CONSOLE_POLL_INTERVAL_MS, 0),
    serviceToken: optional(env.CONSOLE_SERVICE_TOKEN),
    streamSecurityToken: optional(env.QUICKNODE_STREAM_SECURITY_TOKEN),
    publicUrl,
    mcpPublicUrl: optional(env.MCP_PUBLIC_URL),
    mcpLocalUrl: optional(env.MCP_PUBLIC_URL) === null ? localMcpUrl(env) : null,
    sandboxLiquidity: readSandboxLiquidity(env.SANDBOX_LIQUIDITY),
    accounts,
    wake,
    mandates: readMandatesConfig(env),
  };
}

/** `SANDBOX_LIQUIDITY`: unset or empty for none declared, or "mirror-maker"; anything else is refused. */
function readSandboxLiquidity(value: string | undefined): SandboxLiquidity | null {
  const declared = optional(value);
  if (declared === null) return null;
  if (!(SANDBOX_LIQUIDITY as readonly string[]).includes(declared)) {
    throw new Error(
      `SANDBOX_LIQUIDITY must be unset or one of ${SANDBOX_LIQUIDITY.map((kind) => `"${kind}"`).join(", ")}, got "${declared}"`,
    );
  }
  return declared as SandboxLiquidity;
}

/**
 * The MCP server's own address on this machine, from the settings it starts with (`agent/src/config.ts`):
 * `MCP_HOST` (default 127.0.0.1; a wildcard is reached on loopback) and `MCP_PORT` (default 8787).
 */
function localMcpUrl(env: Record<string, string | undefined>): string | null {
  const port = Number(optional(env.MCP_PORT) ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const host = optional(env.MCP_HOST) ?? "127.0.0.1";
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  if (!/^[A-Za-z0-9.-]+$/.test(reachable)) return null;
  return `http://${reachable}:${port.toString()}`;
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
    mcpLocalUrl: null,
    sandboxLiquidity: null,
    wake: readWakeConfig({}),
    mandates: readMandatesConfig({}),
    ...rest,
    accounts: { ...readAccountsConfig({ CONSOLE_MODE: "development" }, publicUrl), ...accounts },
  };
}
