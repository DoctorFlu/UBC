import { randomUUID } from "node:crypto";
import { localhostAllowedOrigins, originValidationResponse } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context";
import { scrubText } from "../logger";
import { runInRequestScope, type McpEndpoint } from "../mcp/server";
import { SERVER_NAME, SERVER_VERSION } from "../version";
import type { AgentContexts } from "../tenancy/agents";
import type { TokenResolver } from "../tenancy/resolver";
import { bearerToken } from "./auth";
import { clientKey, TokenBucketLimiter } from "./rate-limit";

export interface HttpEnv {
  Variables: { requestId: string; agent: AppContext; tokenId: string };
}

/**
 * Failed bearer tokens, per client (one bucket for all without a trusted proxy). It is checked before the
 * console is asked, so a flood of bad tokens is cheap to answer and never reaches the console.
 */
export const FAILED_AUTH_LIMIT = { capacity: 30, refillPerSecond: 0.5 };

function jsonRpcError(c: Context, status: ContentfulStatusCode, code: number, message: string, headers = {}) {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);
}

/** How many JSON-RPC `tools/call` requests a body holds (a single message or a batch). */
function toolCallCount(body: unknown): number {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "tools/call",
  ).length;
}

/** The JSON-RPC method names in a request body, for the log. Names only, never parameters. */
function rpcMethods(body: unknown): string[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages
    .map((message) =>
      typeof message === "object" && message !== null ? (message as { method?: unknown }).method : undefined,
    )
    .filter((method): method is string => typeof method === "string" && /^[\w./-]{1,64}$/.test(method))
    .slice(0, 8);
}

/** Name and version a client states in `initialize`, cut to a safe shape, or undefined. */
function clientInfoOf(body: unknown): string | undefined {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: { clientInfo?: unknown } };
    if (method !== "initialize" || typeof params?.clientInfo !== "object" || params.clientInfo === null)
      continue;
    const { name, version } = params.clientInfo as { name?: unknown; version?: unknown };
    const clean = (value: unknown) =>
      typeof value === "string" ? value.replace(/[^\w .@/-]/g, "").slice(0, 60) : "";
    return `${clean(name)} ${clean(version)}`.trim();
  }
  return undefined;
}

/**
 * The HTTP surface:
 * - `GET /health`: no auth, status and version only.
 * - `POST /mcp`: Origin check, bearer auth (the console says which agent the token acts for), body
 *   limit, a rate limit on tool calls per token, then the MCP endpoint in that agent's context.
 *   Other methods on `/mcp` get 405 because the server is stateless and never streams.
 * - Everything else: 404.
 */
export function createHttpApp(
  app: AppContext,
  endpoint: McpEndpoint,
  tenancy: { resolver: TokenResolver; agents: AgentContexts },
): Hono<HttpEnv> {
  const { config, logger } = app;
  const http = new Hono<HttpEnv>();
  const allowedOrigins = [...localhostAllowedOrigins(), ...config.allowedOrigins];
  // Tool calls are limited per token, keyed by the token's id from the console, never by the token.
  const limiter = new TokenBucketLimiter(config.limits.rateLimit);
  const failedAuthLimiter = new TokenBucketLimiter(FAILED_AUTH_LIMIT);

  http.use("*", async (c, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    c.set("requestId", requestId);
    await next();
    c.header("X-Request-Id", requestId);
    logger.info("http.request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  http.get("/health", (c) => c.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION }));

  http.all(
    "/mcp",
    async (c, next) => {
      // DNS-rebinding defence from the MCP spec: browsers always send Origin, so a page on another
      // site is refused even if it resolves to this machine. Non-browser clients send no Origin.
      const rejected = originValidationResponse(c.req.raw, allowedOrigins);
      if (rejected !== undefined) {
        logger.warn("http.origin_rejected", { requestId: c.get("requestId") });
        return rejected;
      }
      await next();
    },
    async (c, next) => {
      const requestId = c.get("requestId");
      const client = clientKey(c.req.raw, config.trustProxy);
      const tooMany = (retryAfter: number) =>
        jsonRpcError(c, 429, -32000, "Too many requests", { "Retry-After": String(retryAfter) });
      const refuse = () => {
        const retryAfter = failedAuthLimiter.take(client);
        if (retryAfter > 0) return tooMany(retryAfter);
        logger.warn("http.unauthorized", { requestId });
        return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
      };
      // A client that has spent its failed attempts waits without the console being asked at all.
      const blocked = failedAuthLimiter.peek(client);
      if (blocked > 0) return tooMany(blocked);
      const token = bearerToken(c.req.header("authorization"));
      if (token === undefined) return refuse();

      const resolution = await tenancy.resolver.resolve(token, c.req.raw.signal);
      switch (resolution.kind) {
        case "agent":
          c.set("agent", tenancy.agents.contextFor(resolution.agent));
          c.set("tokenId", resolution.agent.tokenId);
          await next();
          return undefined;
        case "unknown":
          return refuse();
        case "limited":
          return tooMany(resolution.retryAfter);
        case "unavailable":
          // Fail closed: without the console's answer no token is accepted, not even the env-file one.
          logger.warn("http.auth_unavailable", { requestId, reason: resolution.reason });
          return jsonRpcError(
            c,
            503,
            -32000,
            "The MCP server cannot check tokens right now. Try again shortly.",
            {
              "Retry-After": "5",
            },
          );
      }
    },
    async (c, next) => {
      if (c.req.method !== "POST") {
        return jsonRpcError(c, 405, -32000, "Method not allowed.", { Allow: "POST" });
      }
      await next();
    },
    bodyLimit({
      maxSize: config.limits.maxBodyBytes,
      onError: (c) => jsonRpcError(c, 413, -32000, "Request body too large"),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return jsonRpcError(c, 400, -32700, "Parse error");
      }
      // The rate limit counts tool calls, the requests that do work. A stateless client such as
      // Grok Bot spends three or four protocol requests (initialize, notifications, a GET probe)
      // on every call; charging those would cut its real budget to a quarter.
      for (let calls = toolCallCount(body); calls > 0; calls -= 1) {
        const retryAfter = limiter.take(c.get("tokenId"));
        if (retryAfter > 0) {
          logger.warn("http.rate_limited", { requestId: c.get("requestId"), retryAfter });
          return jsonRpcError(c, 429, -32000, "Too many requests", { "Retry-After": String(retryAfter) });
        }
      }
      const request = c.req.raw;
      const response = await runInRequestScope(
        { requestId: c.get("requestId"), signal: request.signal, app: c.get("agent") },
        () => endpoint.handle(request, body),
      );
      // Which protocol step this was and how large the answer is. Without it, a client that lists
      // fewer tools than the server has cannot be told apart from one that never asked.
      const client = clientInfoOf(body);
      logger.info("mcp.request", {
        requestId: c.get("requestId"),
        rpc: rpcMethods(body),
        protocol: c.req.header("mcp-protocol-version") ?? null,
        ...(client === undefined ? {} : { client }),
        status: response.status,
        responseBytes: (await response.clone().arrayBuffer()).byteLength,
      });
      return response;
    },
  );

  http.notFound((c) => c.json({ error: "not_found" }, 404));

  http.onError((error, c) => {
    logger.error("http.unhandled_error", {
      requestId: c.get("requestId"),
      name: error.name,
      message: scrubText(error.message).slice(0, 500),
    });
    return c.json({ error: "internal_error" }, 500);
  });

  return http;
}
