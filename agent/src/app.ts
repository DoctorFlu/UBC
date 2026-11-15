import type { Hono } from "hono";
import { ConfigError, isConfigured, type Config } from "./config";
import { createAppContext, type AppContext, type Clock } from "./context";
import { createHttpApp, type HttpEnv } from "./http/app";
import type { Logger } from "./logger";
import { createMcpEndpoint, type McpEndpoint } from "./mcp/server";
import type { Tool } from "./mcp/tool";
import type { Services } from "./services";
import { tools as registeredTools } from "./tools";

export interface MandateServer {
  readonly context: AppContext;
  readonly tools: readonly Tool[];
  /** Web-standard handler for the whole HTTP surface. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly http: Hono<HttpEnv>;
  readonly endpoint: McpEndpoint;
}

/** Fails if a registered tool requires a variable that is not set, naming every missing one. */
export function assertToolRequirements(config: Config, tools: readonly Tool[]): void {
  const problems = tools.flatMap((tool) =>
    tool.requires
      .filter((key) => !isConfigured(config, key))
      .map((key) => `${key}: is not set, and the ${tool.name} tool requires it`),
  );
  if (problems.length > 0) throw new ConfigError(problems);
}

/** Wires config, services, tools and HTTP together, without listening on a port. */
export function createMandateServer(
  config: Config,
  logger: Logger,
  options: { tools?: readonly Tool[]; services?: Partial<Services>; clock?: Clock } = {},
): MandateServer {
  const tools = options.tools ?? registeredTools;
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
  assertToolRequirements(config, tools);

  const context = createAppContext(config, logger, {
    ...options.services,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const endpoint = createMcpEndpoint(context, tools);
  const http = createHttpApp(context, endpoint);
  return { context, tools, endpoint, http, fetch: async (request) => http.fetch(request) };
}
