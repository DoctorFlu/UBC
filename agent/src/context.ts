import type { Config } from "./config";
import { createPaymentReporter } from "./console/payment-reports";
import type { Logger } from "./logger";
import type { CallDeadline } from "./mcp/deadline";
import type { ScopedServices } from "./mcp/scoped-services";
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

/**
 * What a tool handler receives: the app context with its upstream services bound to this call's
 * deadline (`mcp/scoped-services.ts`), plus request-scoped values.
 */
export interface ToolContext extends Omit<AppContext, keyof ScopedServices>, ScopedServices {
  /** Correlates log lines for one HTTP request. */
  readonly requestId: string;
  /**
   * Aborted when the call runs out of time or the client goes away. The scoped services pass it on
   * by themselves; pass it to anything else that waits.
   */
  readonly signal: AbortSignal;
  /** This call's time budget: what is left, and what was slow when it ran out. */
  readonly deadline: CallDeadline;
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
