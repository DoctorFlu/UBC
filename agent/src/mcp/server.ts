import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type * as z from "zod";
import type { AppContext } from "../context";
import { SERVER_INSTRUCTIONS } from "../instructions";
import { SERVER_NAME, SERVER_VERSION } from "../version";
import { invokeTool, type Tool } from "./tool";

/** Values that belong to one HTTP request, available to everything that runs while serving it. */
export interface RequestScope {
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

const requestScope = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return requestScope.run(scope, fn);
}

/**
 * Advertises a zod schema's JSON Schema to clients but lets every value through the SDK's own
 * validation, so `invokeTool` validates instead and reports bad arguments with our stable
 * `INVALID_INPUT` code and without echoing the values.
 */
function advertiseOnly(schema: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "mandate",
      validate: (value) => ({ value: (value ?? {}) as Record<string, unknown> }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}

/** Builds one MCP server instance with every registered tool. Cheap: called once per request. */
export function buildMcpServer(app: AppContext, tools: readonly Tool[]): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Mandate", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: advertiseOnly(tool.inputSchema),
        // `invokeTool` validates every result against the tool's output schema whether or not the
        // schema is advertised, so leaving it out of the list only makes the list smaller.
        ...(app.config.advertiseOutputSchemas ? { outputSchema: tool.outputSchema } : {}),
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args) => invokeTool(tool, args, app, requestScope.getStore() ?? { requestId: randomUUID() }),
    );
  }
  return server;
}

export interface McpEndpoint {
  /**
   * Serves one authenticated POST whose JSON body has already been read and parsed. Both protocol
   * eras get a single JSON response, never a stream.
   */
  handle(request: Request, parsedBody: unknown): Promise<Response>;
  close(): Promise<void>;
}

/**
 * The MCP endpoint, stateless and JSON-only.
 *
 * - 2026-07-28 ("modern") clients go to the SDK's `createMcpHandler` with `responseMode: 'json'`.
 * - 2025-era clients (`initialize` handshake) go to a fresh stateless transport per request with
 *   `enableJsonResponse`, because the SDK's built-in legacy leg answers with a one-shot SSE stream.
 *
 * No sessions and no server-to-client streams, so it works behind buffering proxies such as a
 * Cloudflare quick tunnel and needs no sticky routing.
 */
export function createMcpEndpoint(app: AppContext, tools: readonly Tool[]): McpEndpoint {
  const maxRequestBodySize = app.config.limits.maxBodyBytes;
  const onerror = (error: Error) => {
    app.logger.warn("mcp.transport_error", { name: error.name });
  };
  const modern = createMcpHandler(() => buildMcpServer(app, tools), {
    legacy: "reject",
    responseMode: "json",
    maxRequestBodySize,
    onerror,
  });
  const inFlight = new Set<() => Promise<void>>();
  let closed = false;

  async function serveLegacy(request: Request, parsedBody: unknown): Promise<Response> {
    const server = buildMcpServer(app, tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize,
    });
    transport.onerror = onerror;
    const teardown = async () => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    inFlight.add(teardown);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      inFlight.delete(teardown);
      await teardown();
    }
  }

  return {
    async handle(request, parsedBody) {
      if (closed) throw new Error("MCP endpoint is closed");
      if (await isLegacyRequest(request, parsedBody, { maxRequestBodySize })) {
        return serveLegacy(request, parsedBody);
      }
      return modern.fetch(request, { parsedBody });
    },
    async close() {
      closed = true;
      await Promise.all([modern.close(), ...[...inFlight].map((teardown) => teardown())]);
    },
  };
}
