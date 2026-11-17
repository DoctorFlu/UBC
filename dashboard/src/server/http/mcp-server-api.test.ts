import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimFirstWorkspace, sessionHeader } from "../../../test/support/accounts";
import { type ConsoleConfig, testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { getMcpServer } from "./mcp-server-api";

const silent = { info: () => undefined, warn: () => undefined };

/** A stand-in for the MCP server on this machine: its `/health`, with what it says about its tunnel. */
let health: unknown = null;
let mcp: Server;
let mcpBase = "";

beforeAll(async () => {
  mcp = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health));
  });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  mcpBase = `http://127.0.0.1:${(mcp.address() as AddressInfo).port.toString()}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mcp.close(() => resolve()));
});

async function ask(overrides: Partial<Pick<ConsoleConfig, "mcpPublicUrl" | "mcpLocalUrl">>, signedIn = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-mcp-server-"));
  const service = new ConsoleService(testConsoleConfig(dataDir, overrides), openDatabase(dataDir), {
    env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
    logger: silent,
  });
  const cookie = signedIn ? sessionHeader(service, claimFirstWorkspace(service)) : null;
  const response = await getMcpServer(
    new Request("http://console.test/api/console/mcp-server", { headers: cookie === null ? {} : { cookie } }),
    service,
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

const ok = (publicMcpUrl: unknown) => ({ status: "ok", name: "mandate", version: "0.1.0", publicMcpUrl });

describe("GET /api/console/mcp-server", () => {
  it("answers MCP_PUBLIC_URL as configured, without asking anything", async () => {
    expect(await ask({ mcpPublicUrl: "https://mcp.example.dev/mcp", mcpLocalUrl: mcpBase })).toEqual({
      status: 200,
      body: { kind: "configured", url: "https://mcp.example.dev/mcp" },
    });
  });

  it("gives the local address of a running server, and how Grok Bot can reach it once a tunnel did", async () => {
    health = ok(null);
    expect((await ask({ mcpLocalUrl: mcpBase })).body).toEqual({
      kind: "local",
      localUrl: `${mcpBase}/mcp`,
      running: true,
      publicUrl: null,
    });
    health = ok("https://and-judgment-related-profiles.trycloudflare.com/mcp");
    expect((await ask({ mcpLocalUrl: mcpBase })).body).toMatchObject({
      running: true,
      publicUrl: "https://and-judgment-related-profiles.trycloudflare.com/mcp",
    });
  });

  it("never passes on a public address that is not https", async () => {
    for (const publicMcpUrl of ["http://plain.example/mcp", "javascript:alert(1)", 42]) {
      health = ok(publicMcpUrl);
      expect((await ask({ mcpLocalUrl: mcpBase })).body).toMatchObject({ running: true, publicUrl: null });
    }
  });

  it("says when nothing answers on this machine, and when there is nothing to ask", async () => {
    expect((await ask({ mcpLocalUrl: "http://127.0.0.1:9" })).body).toEqual({
      kind: "local",
      localUrl: "http://127.0.0.1:9/mcp",
      running: false,
      publicUrl: null,
    });
    expect((await ask({})).body).toEqual({ kind: "unknown" });
  });

  it("is for signed-in members only", async () => {
    expect((await ask({ mcpLocalUrl: mcpBase }, false)).status).toBe(401);
  });
});
