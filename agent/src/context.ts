import type { Config } from "./config";
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
  return { ...createServices(config), ...services, config, logger, clock };
}
