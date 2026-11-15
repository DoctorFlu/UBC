/**
 * Service interfaces tool handlers depend on.
 *
 * Each interface is deliberately minimal: it names the dependency and carries only what is known
 * today. The issue that implements a service extends its interface here with the methods its
 * tools need and adds the factory in `createServices`. A service is `undefined` when the
 * configuration it needs is missing, so a tool can answer with an `unavailable` verdict instead of
 * failing.
 */
import type { Address, Config } from "./config";

/** Reads the onchain Policy contract and submits intents to it (issues #10, #11, #32, #33). */
export interface PolicyClient {
  /** Address of the Policy contract this client talks to. */
  readonly policyAddress: Address;
}

/** Read-only access to Gemini prediction-market data from `@mandate/gemini` (issue #10). */
export interface MarketsClient {
  /** The venue the markets come from. */
  readonly venue: "gemini";
}

/** Turns a holding and a strike ladder into a protection plan, from `@mandate/planner` (issue #10). */
export interface HedgePlanner {
  /** Version of the planning model, recorded with each plan. */
  readonly version: string;
}

/** The console backend: holdings the owner entered and policy change requests (issues #10, #32, #34). */
export interface ConsoleClient {
  /** Base URL of the console backend. */
  readonly baseUrl: string;
}

/** Pays for signals through the x402 buyer in `src/x402` and enforces the daily tool budget (issue #21). */
export interface PaymentsClient {
  /** Address of the wallet that pays for signals. */
  readonly payer: Address;
}

export interface Services {
  readonly policy: PolicyClient | undefined;
  readonly markets: MarketsClient | undefined;
  readonly planner: HedgePlanner | undefined;
  readonly console: ConsoleClient | undefined;
  readonly payments: PaymentsClient | undefined;
}

/**
 * Builds the services the configuration allows. Until an issue adds a real implementation, a
 * service is `undefined`, which tools report as `unavailable`.
 */
export function createServices(_config: Config): Services {
  return {
    policy: undefined,
    markets: undefined,
    planner: undefined,
    console: undefined,
    payments: undefined,
  };
}
