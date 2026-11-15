import { createHash, randomUUID } from "node:crypto";
import { localhostAllowedOrigins, originValidationResponse } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context";
import { scrubText } from "../logger";
import { runInRequestScope, type McpEndpoint } from "../mcp/server";
import { SERVER_NAME, SERVER_VERSION } from "../version";
import { isAuthorized } from "./auth";
import { TokenBucketLimiter } from "./rate-limit";

export interface HttpEnv {
  Variables: { requestId: string };
}

/** Failed authentication attempts share one bucket, so a flood of bad tokens is cheap to answer. */
const FAILED_AUTH_LIMIT = { capacity: 30, refillPerSecond: 0.5 };

function jsonRpcError(c: Context, status: ContentfulStatusCode, code: number, message: string, headers = {}) {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);
}

/**
 * The HTTP surface:
 * - `GET /health`: no auth, status and version only.
 * - `POST /mcp`: Origin check, bearer auth, rate limit, body limit, then the MCP endpoint.
 *   Other methods on `/mcp` get 405 because the server is stateless and never streams.
 * - Everything else: 404.
 */
export function createHttpApp(app: AppContext, endpoint: McpEndpoint): Hono<HttpEnv> {
  const { config, logger } = app;
  const http = new Hono<HttpEnv>();
  const allowedOrigins = [...localhostAllowedOrigins(), ...config.allowedOrigins];
  const limiter = new TokenBucketLimiter(config.limits.rateLimit);
  const failedAuthLimiter = new TokenBucketLimiter(FAILED_AUTH_LIMIT);
  // Rate limits are per bearer token. Key the bucket by a hash so the token never sits in a map key.
  const tokenKey = createHash("sha256").update(config.authToken.reveal()).digest("hex").slice(0, 16);

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
      if (isAuthorized(c.req.header("authorization"), config.authToken)) {
        await next();
        return;
      }
      const retryAfter = failedAuthLimiter.take("unauthenticated");
      if (retryAfter > 0) {
        return jsonRpcError(c, 429, -32000, "Too many requests", { "Retry-After": String(retryAfter) });
      }
      logger.warn("http.unauthorized", { requestId: c.get("requestId") });
      return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    },
    async (c, next) => {
      const retryAfter = limiter.take(tokenKey);
      if (retryAfter > 0) {
        logger.warn("http.rate_limited", { requestId: c.get("requestId"), retryAfter });
        return jsonRpcError(c, 429, -32000, "Too many requests", { "Retry-After": String(retryAfter) });
      }
      await next();
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
      const request = c.req.raw;
      return runInRequestScope({ requestId: c.get("requestId"), signal: request.signal }, () =>
        endpoint.handle(request, body),
      );
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
