import "server-only";

import { resolve } from "node:path";

import type { EnvVars } from "@mandate/shared/node";

import { readConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";
import { getMarketQuotes } from "./market/quotes";

/**
 * One console service per server process. It lives on `globalThis` because Next.js may load server
 * modules more than once (route handlers and server components, and again after a dev reload).
 */
const KEY = Symbol.for("mandate.console-service");

type Holder = Record<typeof KEY, ConsoleService | undefined>;

/**
 * The environment the console resolves its deployment from. Bundled server code has no reliable path of
 * its own, so the devchain's deployment file is located from the dashboard folder Next.js runs in
 * (`npm run dev:chain` writes `devchain/deployments/local.json`) unless `POLICY_DEPLOYMENT_FILE` is set.
 */
function consoleEnv(): EnvVars {
  if (process.env.POLICY_DEPLOYMENT_FILE?.trim()) return process.env;
  return {
    ...process.env,
    // Read at runtime, not bundled: `turbopackIgnore` keeps the bundler from tracing it.
    POLICY_DEPLOYMENT_FILE: resolve(
      /* turbopackIgnore: true */ process.cwd(),
      "..",
      "devchain",
      "deployments",
      "local.json",
    ),
  };
}

/** The running console service, created and started on first use. */
export function getConsoleService(): ConsoleService {
  const holder = globalThis as unknown as Holder;
  let service = holder[KEY];
  if (!service) {
    const config = readConsoleConfig();
    service = new ConsoleService(config, openDatabase(config.dataDir), {
      env: consoleEnv(),
      // Through the hedge view's cached Gemini client, so both share one rate limit and event cache.
      marketLookup: (symbol) => getMarketQuotes().marketCategory(symbol),
    });
    holder[KEY] = service;
  }
  service.start();
  return service;
}

/** Replaces the process-wide service; for tests that call route handlers directly. */
export function setConsoleServiceForTests(service: ConsoleService | undefined): void {
  (globalThis as unknown as Holder)[KEY] = service;
}
