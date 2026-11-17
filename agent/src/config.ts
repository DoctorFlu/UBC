import { privateKeyToAccount } from "viem/accounts";
import * as z from "zod";
import { ARC_TESTNET } from "@mandate/shared";
import { Secret } from "./secret";
import {
  PAYMENTS_ENV_KEYS,
  paymentsConfigFrom,
  paymentsEnvShape,
  type PaymentsConfig,
} from "./x402/payments-config";

/** Every environment variable the MCP server reads. */
export const ENV_KEYS = [
  "MCP_PORT",
  "MCP_HOST",
  "MCP_AUTH_TOKEN",
  "MCP_ALLOWED_ORIGINS",
  "MCP_LOG_LEVEL",
  "MCP_ADVERTISE_OUTPUT_SCHEMAS",
  "MCP_TRUST_PROXY",
  "MCP_TOOL_DEADLINE_MS",
  "ARC_RPC_URL",
  "POLICY_ADDRESS",
  "POLICY_DEPLOY_BLOCK",
  "AGENT_PRIVATE_KEY",
  "CONSOLE_URL",
  "CONSOLE_SERVICE_TOKEN",
  "SIGNALS_URL",
  ...PAYMENTS_ENV_KEYS,
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/**
 * Variables without a default, which a tool may declare in `requires`. When a registered tool
 * requires one, the server refuses to start without it. Otherwise they stay optional so a partly
 * configured server still starts and `get_setup_state` can tell the owner what is missing.
 */
export type OptionalEnvKey = Extract<
  EnvKey,
  "POLICY_ADDRESS" | "AGENT_PRIVATE_KEY" | "CONSOLE_SERVICE_TOKEN"
>;

export const DEFAULT_CONSOLE_URL = "http://localhost:3000";
export const DEFAULT_SIGNALS_URL = "http://localhost:4021";

export const MIN_AUTH_TOKEN_LENGTH = 32;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Bounds of `MCP_TOOL_DEADLINE_MS`: well under the 60 s an MCP client waits by default. */
export const TOOL_DEADLINE_RANGE_MS = { min: 1_000, max: 40_000 } as const;

export interface Limits {
  /** Largest accepted request body, in bytes. */
  readonly maxBodyBytes: number;
  /**
   * Time budget for one tool call, in milliseconds (`MCP_TOOL_DEADLINE_MS`). When it runs out, every
   * upstream request of the call is aborted and the tool answers with what was slow.
   */
  readonly toolDeadlineMs: number;
  /** Token bucket of tool calls per bearer token: burst size and steady refill rate. */
  readonly rateLimit: { readonly capacity: number; readonly refillPerSecond: number };
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  /**
   * Whether `tools/list` includes each tool's output schema. Off by default: the schemas are three
   * quarters of the list's size, a chat agent reads the result itself, and results are validated
   * against them on the server either way.
   */
  readonly advertiseOutputSchemas: boolean;
  /**
   * The env-file token. It acts for the first mandate's agent until the owner revokes it in the console,
   * which decides every token (docs/accounts.md); the server never accepts it on its own.
   */
  readonly authToken: Secret;
  /** Extra hostnames allowed in a browser `Origin` header, on top of localhost. */
  readonly allowedOrigins: readonly string[];
  /**
   * Whether a proxy (Caddy) sits in front: failed bearer tokens are then limited per client address from
   * `X-Forwarded-For`. Without it, they share one limit.
   */
  readonly trustProxy: boolean;
  /** Arc RPC endpoint. Wrapped because hosted endpoints embed an API key in the path. */
  readonly arcRpcUrl: Secret;
  readonly policyAddress: Address | undefined;
  /** Block the Policy contract was deployed in, where event scans start. Unset: a recent window. */
  readonly policyDeployBlock: bigint | undefined;
  readonly agentPrivateKey: Secret<Hex> | undefined;
  /** Public address derived from `agentPrivateKey` at startup. */
  readonly agentAddress: Address | undefined;
  readonly consoleUrl: string;
  readonly consoleServiceToken: Secret | undefined;
  readonly signalsUrl: string;
  readonly limits: Limits;
  /** Paying for signals: buyer key, daily budget, price cap, data directory. */
  readonly payments: PaymentsConfig;
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 256 * 1024,
  toolDeadlineMs: 25_000,
  rateLimit: { capacity: 60, refillPerSecond: 1 },
};

const notSet = (hint: string) => (issue: { input: unknown }) =>
  issue.input === undefined ? `is not set. ${hint}` : undefined;

const url = (name: string) =>
  z.string().refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
    message: `must be an http(s) URL for ${name}`,
  });

const EnvSchema = z.object({
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  MCP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_AUTH_TOKEN: z
    .string({ error: notSet("Run `npm run mcp:token` to generate one.") })
    .min(MIN_AUTH_TOKEN_LENGTH, {
      message: `must be at least ${MIN_AUTH_TOKEN_LENGTH} characters. Run \`npm run mcp:token\` to generate one.`,
    }),
  MCP_ALLOWED_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ""),
    )
    .default([]),
  MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MCP_ADVERTISE_OUTPUT_SCHEMAS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MCP_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MCP_TOOL_DEADLINE_MS: z.coerce
    .number()
    .int({ message: "must be a whole number of milliseconds" })
    .min(TOOL_DEADLINE_RANGE_MS.min, {
      message: `must be at least ${TOOL_DEADLINE_RANGE_MS.min} ms`,
    })
    .max(TOOL_DEADLINE_RANGE_MS.max, {
      message: `must be at most ${TOOL_DEADLINE_RANGE_MS.max} ms, well under the 60 s MCP clients wait`,
    })
    .optional(),
  ARC_RPC_URL: url("the Arc RPC").default(ARC_TESTNET.rpcUrl),
  POLICY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, { message: "must be a 0x-prefixed 20-byte address" })
    .transform((value) => value as Address)
    .optional(),
  POLICY_DEPLOY_BLOCK: z
    .string()
    .regex(/^\d{1,15}$/, { message: "must be a block number" })
    .optional(),
  AGENT_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, { message: "must be a 0x-prefixed 32-byte hex private key" })
    .transform((value) => value as Hex)
    .optional(),
  CONSOLE_URL: url("the console").default(DEFAULT_CONSOLE_URL),
  CONSOLE_SERVICE_TOKEN: z.string().min(16, { message: "must be at least 16 characters" }).optional(),
  SIGNALS_URL: url("the signal API").default(DEFAULT_SIGNALS_URL),
  ...paymentsEnvShape,
});

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid MCP server configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Parses the environment once. Empty values count as unset, so `.env.example`-style blank lines
 * work. Error messages name the variable and the rule it broke, never the value.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  limits = DEFAULT_LIMITS,
): Config {
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") input[key] = value;
  }

  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const vars = parsed.data;

  let agentAddress: Address | undefined;
  if (vars.AGENT_PRIVATE_KEY !== undefined) {
    try {
      agentAddress = privateKeyToAccount(vars.AGENT_PRIVATE_KEY).address;
    } catch {
      throw new ConfigError(["AGENT_PRIVATE_KEY: is not a valid secp256k1 private key"]);
    }
  }
  const payments = paymentsConfigFrom(vars);
  if (!payments.ok) throw new ConfigError(payments.problems);

  return {
    port: vars.MCP_PORT,
    host: vars.MCP_HOST,
    logLevel: vars.MCP_LOG_LEVEL,
    advertiseOutputSchemas: vars.MCP_ADVERTISE_OUTPUT_SCHEMAS,
    authToken: new Secret(vars.MCP_AUTH_TOKEN),
    allowedOrigins: vars.MCP_ALLOWED_ORIGINS,
    trustProxy: vars.MCP_TRUST_PROXY,
    arcRpcUrl: new Secret(vars.ARC_RPC_URL),
    policyAddress: vars.POLICY_ADDRESS,
    policyDeployBlock: vars.POLICY_DEPLOY_BLOCK === undefined ? undefined : BigInt(vars.POLICY_DEPLOY_BLOCK),
    agentPrivateKey: vars.AGENT_PRIVATE_KEY === undefined ? undefined : new Secret(vars.AGENT_PRIVATE_KEY),
    agentAddress,
    consoleUrl: vars.CONSOLE_URL,
    consoleServiceToken:
      vars.CONSOLE_SERVICE_TOKEN === undefined ? undefined : new Secret(vars.CONSOLE_SERVICE_TOKEN),
    signalsUrl: vars.SIGNALS_URL,
    limits:
      vars.MCP_TOOL_DEADLINE_MS === undefined
        ? limits
        : { ...limits, toolDeadlineMs: vars.MCP_TOOL_DEADLINE_MS },
    payments: payments.config,
  };
}

/** Whether an optional variable was provided. */
export function isConfigured(config: Config, key: OptionalEnvKey): boolean {
  switch (key) {
    case "POLICY_ADDRESS":
      return config.policyAddress !== undefined;
    case "AGENT_PRIVATE_KEY":
      return config.agentPrivateKey !== undefined;
    case "CONSOLE_SERVICE_TOKEN":
      return config.consoleServiceToken !== undefined;
  }
}

/** The host part of the RPC URL, safe to show: hosted endpoints keep their API key in the path. */
export function rpcHost(config: Config): string {
  return new URL(config.arcRpcUrl.reveal()).host;
}
