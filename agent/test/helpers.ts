import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMandateServer, type MandateServer } from "../src/app";
import { DEFAULT_LIMITS, parseConfig, type Config, type Limits } from "../src/config";
import type { Clock } from "../src/context";
import { createLogger, type Logger } from "../src/logger";
import type { Tool } from "../src/mcp/tool";
import type { Services } from "../src/services";
import { envAgent, staticResolver, type TokenResolver } from "../src/tenancy/resolver";

export const TEST_TOKEN = randomBytes(32).toString("base64url");
/**
 * A throwaway key, never funded or used for anything real. Not one of anvil's published keys: the server
 * refuses those for Arc testnet, the default RPC.
 */
export const TEST_PRIVATE_KEY = `0x${"4d".repeat(32)}` as const;
export const TEST_ADDRESS = "0xba32858eA15Ad4A729d3aCA3c2ed5E3363Bc16f6";
export const TEST_POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Another throwaway key (the second Hardhat account) for the signal buyer, never funded. */
export const TEST_BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TEST_BUYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export function testConfig(env: Record<string, string> = {}, limits: Partial<Limits> = {}): Config {
  return parseConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, ...env }, { ...DEFAULT_LIMITS, ...limits });
}

/** A console stand-in that knows one token, `TEST_TOKEN`, for the first mandate's agent. */
export function testResolver(): TokenResolver {
  return staticResolver(new Map([[TEST_TOKEN, envAgent()]]));
}

export function captureLogs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

export const fixedClock: Clock = { now: () => new Date("2026-11-15T12:00:00.000Z") };

export function testServer(
  options: {
    env?: Record<string, string>;
    limits?: Partial<Limits>;
    tools?: readonly Tool[];
    services?: Partial<Services>;
    clock?: Clock;
    /** Defaults to one token, `TEST_TOKEN`, for the first mandate's agent. */
    resolver?: TokenResolver;
  } = {},
): MandateServer & { lines: string[] } {
  const { logger, lines } = captureLogs();
  const server = createMandateServer(testConfig(options.env, options.limits), logger, {
    clock: options.clock ?? fixedClock,
    resolver: options.resolver ?? testResolver(),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.services === undefined ? {} : { services: options.services }),
  });
  return Object.assign(server, { lines });
}

/** An SDK client wired to the in-process server through its fetch handler, with the bearer token. */
export async function connectClient(
  server: MandateServer,
  options: { era?: "legacy" | "auto"; token?: string } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
    fetch: (url, init) => server.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${options.token ?? TEST_TOKEN}` } },
  });
  const client = new Client(
    { name: "mandate-test", version: "0.0.0" },
    options.era === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(transport);
  return client;
}

export function post(
  server: MandateServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    server.fetch(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}

export const authHeader = (token = TEST_TOKEN) => ({ authorization: `Bearer ${token}` });

export const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};
