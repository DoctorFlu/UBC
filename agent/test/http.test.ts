import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/version";
import { authHeader, initializeRequest, post, TEST_TOKEN, testServer } from "./helpers";

const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list" };

describe("GET /health", () => {
  it("answers without auth and exposes only status, name and version", async () => {
    const response = await testServer().fetch(new Request("http://127.0.0.1:8787/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", name: "mandate", version: SERVER_VERSION });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("authentication", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong token", authHeader("x".repeat(43))],
    ["a token that is a prefix of the right one", authHeader(TEST_TOKEN.slice(0, -1))],
    ["the right token with the wrong scheme", { authorization: `Basic ${TEST_TOKEN}` }],
    ["the right token with no scheme", { authorization: TEST_TOKEN }],
  ])("refuses %s with 401, WWW-Authenticate: Bearer and no detail", async (_case, headers) => {
    const response = await post(testServer(), initializeRequest, headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts the right token, with any capitalization of the scheme", async () => {
    const server = testServer();
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const response = await post(server, initializeRequest, { authorization: `${scheme} ${TEST_TOKEN}` });
      expect(response.status).toBe(200);
    }
  });

  it("refuses unauthenticated GET and DELETE too", async () => {
    const server = testServer();
    for (const method of ["GET", "DELETE"]) {
      const response = await server.fetch(new Request("http://127.0.0.1:8787/mcp", { method }));
      expect(response.status).toBe(401);
    }
  });
});

describe("routing and limits", () => {
  it("answers 404 for unknown paths", async () => {
    const server = testServer();
    for (const path of ["/", "/mcp/", "/sse", "/messages", "/.well-known/oauth-protected-resource"]) {
      const response = await server.fetch(
        new Request(`http://127.0.0.1:8787${path}`, { headers: authHeader() }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("answers 405 for GET and DELETE on /mcp because the server never streams or keeps sessions", async () => {
    const server = testServer();
    for (const method of ["GET", "DELETE"]) {
      const response = await server.fetch(
        new Request("http://127.0.0.1:8787/mcp", { method, headers: authHeader() }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("refuses a browser Origin that is not allowed, and accepts localhost and configured origins", async () => {
    const server = testServer({ env: { MCP_ALLOWED_ORIGINS: "console.example.com" } });
    const evil = await post(server, initializeRequest, { ...authHeader(), origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const local = await post(server, initializeRequest, { ...authHeader(), origin: "http://localhost:6274" });
    expect(local.status).toBe(200);
    const configured = await post(server, initializeRequest, {
      ...authHeader(),
      origin: "https://console.example.com",
    });
    expect(configured.status).toBe(200);
  });

  it("refuses bodies over the size limit with 413", async () => {
    const server = testServer({ limits: { maxBodyBytes: 1024 } });
    const big = { ...listTools, params: { padding: "x".repeat(2048) } };
    const response = await post(server, big, authHeader());
    expect(response.status).toBe(413);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const response = await post(testServer(), "{not json", authHeader());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("rate limits per token with 429 and Retry-After", async () => {
    const server = testServer({ limits: { rateLimit: { capacity: 3, refillPerSecond: 0.01 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await post(server, initializeRequest, authHeader())).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await post(server, initializeRequest, authHeader());
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
