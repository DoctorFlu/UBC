/**
 * The executor's settings from the environment.
 *
 * SIM_EXECUTOR_DELAY_MS   how long it waits after an approval before recording the fill (default 1500)
 * SIM_EXECUTOR_POLL_MS    how often it asks the chain for new approvals (default 1000, the watcher's own
 *                         default, which suits a laptop). A hosted demo sets it higher so the machine can go
 *                         quiet between visits.
 * EXECUTOR_SETTLE_MS      how often it looks for a filled position that is due to be settled (default
 *                         60000). The look is local; Gemini and the console are asked only about a position
 *                         whose market has expired, then with a backoff while the outcome is unpublished.
 * CONSOLE_URL             the console it records settlements in (default http://localhost:3000), the same
 *                         variable the MCP server reads.
 * EXECUTOR_VENUE          simulated (default: places nothing) or gemini (issue #93: places approved orders on
 *                         Gemini; the GEMINI_* settings in @mandate/gemini/private say where and with which key).
 * EXECUTOR_ORDER_TTL_MS   gemini only: how long an order rests unfilled before the rest is cancelled (default
 *                         600000, 10 minutes; at least 10000).
 * EXECUTOR_DISCOVERY_MS   how often it asks the console which contracts name it as their executor (#95:
 *                         one executor serves every mandate's contract; default 15000, at least 1000).
 */
import { executorVenueKind, type ExecutorVenueKind } from "@mandate/gemini";

export interface ExecutorSettings {
  fillDelayMs: number;
  pollingIntervalMs: number | undefined;
  settleIntervalMs: number;
  consoleUrl: string;
  venue: ExecutorVenueKind;
  orderTtlMs: number;
  discoveryIntervalMs: number;
}

function wholeMs(name: string, raw: string | undefined, min: number): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `${name} must be a whole number of milliseconds, at least ${String(min)}, got "${value}"`,
    );
  }
  return parsed;
}

export function executorSettings(env: Record<string, string | undefined>): ExecutorSettings {
  const consoleUrl = env.CONSOLE_URL?.trim() || "http://localhost:3000";
  if (!URL.canParse(consoleUrl)) throw new Error(`CONSOLE_URL must be a URL, got "${consoleUrl}"`);
  const venue = executorVenueKind(env);
  return {
    venue,
    orderTtlMs: wholeMs("EXECUTOR_ORDER_TTL_MS", env.EXECUTOR_ORDER_TTL_MS, 10_000) ?? 600_000,
    discoveryIntervalMs: wholeMs("EXECUTOR_DISCOVERY_MS", env.EXECUTOR_DISCOVERY_MS, 1_000) ?? 15_000,
    fillDelayMs: wholeMs("SIM_EXECUTOR_DELAY_MS", env.SIM_EXECUTOR_DELAY_MS, 0) ?? 1_500,
    pollingIntervalMs: wholeMs("SIM_EXECUTOR_POLL_MS", env.SIM_EXECUTOR_POLL_MS, 50),
    settleIntervalMs: wholeMs("EXECUTOR_SETTLE_MS", env.EXECUTOR_SETTLE_MS, 1_000) ?? 60_000,
    consoleUrl,
  };
}
