import type { Handler } from "hono";

/**
 * One paid endpoint.
 * The app registers the handler, puts the route behind the x402 payment middleware at `priceUsd`,
 * and lists it on the free discovery endpoint.
 * To add a paid endpoint (issue #20), write a `PaidRoute` and pass it in `createSignalsApp({ routes })`.
 */
export interface PaidRoute {
  method: "GET";
  /** Hono path, for example `/v1/signal/hello`. */
  path: `/${string}`;
  /** Price per request in USDC as a decimal string, for example `"0.001"`. */
  priceUsd: string;
  description: string;
  /** Example of the JSON the route returns once paid, shown on the discovery endpoint. */
  exampleResponse: unknown;
  handler: Handler;
}
