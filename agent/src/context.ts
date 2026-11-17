import type { Config } from "./config";
import { createPaymentReporter } from "./console/payment-reports";
import type { Logger } from "./logger";
import { createServices, type Services } from "./services";
import { SERVER_AGENT, type AgentIdentity } from "./tenancy/agents";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * The dependencies a call runs with. The server builds one at startup for its own agent, and one per
 * agent a token resolves to (`tenancy/agents.ts`), each with that agent's services.
 */
export interface AppContext extends Services {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The agent the call acts for. */
  readonly agent: AgentIdentity;
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
  return { ...merged, paymentReports, config, logger, clock, agent: SERVER_AGENT };
}
