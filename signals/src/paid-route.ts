import type { Context, Handler } from "hono";

/** One query parameter of a paid route, as the discovery endpoint describes it. */
export interface QueryParameter {
  name: string;
  required: boolean;
  description: string;
}

/**
 * One paid endpoint.
 * The app registers the handler, puts the route behind the x402 payment middleware at `priceUsd`,
 * and lists it on the free discovery endpoint.
 * To add a paid endpoint, write a `PaidRoute` and pass it in `createSignalsApp({ routes })`.
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
  /** Query parameters, shown on the discovery endpoint. */
  query?: readonly QueryParameter[];
  /** JSON Schema of the paid response, shown on the discovery endpoint. */
  responseSchema?: unknown;
  /**
   * Runs before the payment middleware, on every request, paid or not.
   * Return a response to refuse the request for free (it is never sent a 402, so the buyer never
   * signs), or undefined to continue to payment. Use it to do every check and every piece of I/O the
   * paid handler would otherwise need, so the handler cannot fail after the buyer has paid.
   */
  precheck?: (c: Context) => Promise<Response | undefined>;
  /**
   * Runs after payment is verified and before it is settled. If it returns a status of 400 or more,
   * the payment is not settled. Keep it to computation without side effects: if settlement fails,
   * its output is thrown away (see docs/x402.md).
   */
  handler: Handler;
}
