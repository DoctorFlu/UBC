import { serve } from "@hono/node-server";
import { createMandateServer } from "./app";
import { ConfigError, parseConfig } from "./config";
import { applyDeploymentFile } from "./deployment-file";
import { loadEnvFile, resolveEnvFile } from "./env-file";
import { createLogger } from "./logger";
import { SERVER_VERSION } from "./version";

const SHUTDOWN_GRACE_MS = 10_000;

/**
 * How long an idle keep-alive connection stays open.
 *
 * It must be longer than the idle timeout of whatever proxy sits in front of this server.
 * Node's default is 5 s, while cloudflared reuses an idle origin connection for up to 90 s and
 * the hosted Caddy for up to 2 minutes; 120 s would only tie with Caddy.
 * With the default, a request that arrives just as Node closes the connection never reaches
 * this process, the proxy answers 502, and the MCP client reports a failed tool call.
 */
const KEEP_ALIVE_TIMEOUT_MS = 130_000;

/** Runs `build`, and on a configuration problem prints it (never a value) and exits. */
function orExit<T>(build: () => T, envFile: string): T {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\nEnv file: ${envFile}\n`);
    process.exit(1);
  }
}

function main(): void {
  const envFile = resolveEnvFile();
  const loaded = loadEnvFile(envFile);
  const envFileLabel = loaded ? envFile : `${envFile} (not found)`;

  const config = orExit(() => parseConfig(applyDeploymentFile(process.env)), envFileLabel);
  const logger = createLogger({ level: config.logLevel });
  const server = orExit(() => createMandateServer(config, logger), envFileLabel);

  const listener = serve(
    {
      fetch: server.fetch,
      port: config.port,
      hostname: config.host,
      serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS },
    },
    (info) => {
      logger.info("server.listening", {
        host: config.host,
        port: info.port,
        endpoint: "/mcp",
        version: SERVER_VERSION,
        keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
        tools: server.tools.map((tool) => tool.name),
        marketData: `${config.marketData.environment} (${config.marketData.settings})`,
        envFile: envFileLabel,
      });
    },
  );
  // Deliver signal payments and the budget the console has not recorded yet, then keep retrying.
  const stopPaymentReports = server.context.paymentReports?.start();

  listener.on("error", (error: Error) => {
    logger.error("server.listen_failed", { name: error.name, message: error.message });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn("server.forced_exit", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("server.shutting_down", { signal });
    stopPaymentReports?.();
    setTimeout(() => {
      logger.warn("server.shutdown_timeout", { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    // Stop accepting connections, abort in-flight MCP exchanges, then exit once sockets drain.
    listener.close(() => {
      logger.info("server.stopped");
      process.exit(0);
    });
    if ("closeIdleConnections" in listener) listener.closeIdleConnections();
    void server.endpoint.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
