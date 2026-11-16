import type { Config } from "./config";
import { createPaymentReporter } from "./console/payment-reports";
import type { Logger } from "./logger";
import { createServices, type Services } from "./services";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Process-wide dependencies, built once at startup. */
export interface AppContext extends Services {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** What a tool handler receives: the app context plus request-scoped values. */
export interface ToolContext extends AppContext {
  /** Correlates log lines for one HTTP request. */
  readonly requestId: string;
  /** Aborted when the tool call times out or the server shuts down. Pass it to upstream calls. */
  readonly signal: AbortSignal;
}

export function createAppContext(
  config: Config,
  logger: Logger,
  overrides: Partial<Services> & { clock?: Clock } = {},
): AppContext {
  const { clock = systemClock, ...services } = overrides;
  const merged = { ...createServices(config), ...services };
  // Built from the final console and payments, so a test that swaps either gets a matching reporter.
  const paymentReports =
    "paymentReports" in services ? services.paymentReports : createPaymentReporter(merged, logger, clock);
  return { ...merged, paymentReports, config, logger, clock };
}
