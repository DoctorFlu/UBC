import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMandateServer, type MandateServer } from "../src/app";
import { DEFAULT_LIMITS, parseConfig, type Config, type Limits } from "../src/config";
import type { Clock } from "../src/context";
import { createLogger, type Logger } from "../src/logger";
import type { Tool } from "../src/mcp/tool";

export const TEST_TOKEN = randomBytes(32).toString("base64url");
/** A throwaway key (the well-known first Hardhat account), never used for anything real. */
export const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const TEST_POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export function testConfig(env: Record<string, string> = {}, limits: Partial<Limits> = {}): Config {
  return parseConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, ...env }, { ...DEFAULT_LIMITS, ...limits });
}

export function captureLogs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

export const fixedClock: Clock = { now: () => new Date("2026-11-15T12:00:00.000Z") };

export function testServer(
  options: { env?: Record<string, string>; limits?: Partial<Limits>; tools?: readonly Tool[] } = {},
): MandateServer & { lines: string[] } {
  const { logger, lines } = captureLogs();
  const server = createMandateServer(testConfig(options.env, options.limits), logger, {
    clock: fixedClock,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
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
