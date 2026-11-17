import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import type { GeminiEnvironment } from "@mandate/gemini";
import { ARC_TESTNET } from "@mandate/shared";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono, type MiddlewareHandler } from "hono";
import { parseUnits, type Address } from "viem";
import type { PaidRoute, QueryParameter } from "./paid-route";
import { helloRoute } from "./routes/hello";

export interface SignalsAppOptions {
  sellerAddress: Address;
  /** CAIP-2 network to accept payments on. Defaults to Arc testnet. */
  network?: Network;
  /**
   * x402 facilitator. Defaults to Circle Gateway (`BatchFacilitatorClient`) at `facilitatorUrl`.
   * Tests inject a fake so they run offline.
   */
  facilitator?: FacilitatorClient;
  /** Circle Gateway API base URL, used when `facilitator` is not given. */
  facilitatorUrl?: string;
  /** Paid routes to serve. Defaults to the hello route. */
  routes?: readonly PaidRoute[];
  /**
   * Which Gemini the signals read (`marketDataSource`), told on the free health route so the MCP server
   * can check it agrees before it pays. Defaults to production.
   */
  marketEnvironment?: GeminiEnvironment;
}

/** Discovery document served at `GET /v1/resources`. */
export interface ResourceCatalog {
  x402Version: 2;
  seller: Address;
  network: string;
  facilitator: string;
  resources: {
    method: string;
    path: string;
    url: string;
    priceUsd: string;
    /** Price in USDC base units (6 decimals). */
    amount: string;
    asset: string;
    scheme: "exact";
    /** x402 `extra.name` of the Circle Gateway batched payment option. */
    settlement: "GatewayWalletBatched";
    mimeType: "application/json";
    description: string;
    /** Query parameters the route takes, when it takes any. */
    query?: readonly QueryParameter[];
    /** JSON Schema of the paid response, when the route publishes one. */
    responseSchema?: unknown;
    exampleResponse: unknown;
  }[];
}

/**
 * Builds the signals HTTP app.
 * `GET /health` and `GET /v1/resources` are free.
 * Every paid route sits behind the x402 middleware with Circle Gateway batched settlement.
 * A route's `precheck` runs before that middleware, so its refusals are free.
 */
export function createSignalsApp(options: SignalsAppOptions): Hono {
  const network = options.network ?? ARC_TESTNET.network;
  const routes = options.routes ?? [helloRoute];
  const facilitatorUrl = options.facilitatorUrl ?? ARC_TESTNET.gatewayApiUrl;
  const facilitator: FacilitatorClient =
    options.facilitator ?? (new BatchFacilitatorClient({ url: facilitatorUrl }) as FacilitatorClient);

  // GatewayEvmScheme is the stock `exact` EVM scheme plus the Gateway `extra` fields
  // (name "GatewayWalletBatched", version, verifyingContract) that buyers sign against.
  const resourceServer = new x402ResourceServer(facilitator).register(network, new GatewayEvmScheme());

  const routesConfig: RoutesConfig = Object.fromEntries(
    routes.map((route) => [
      `${route.method} ${route.path}`,
      {
        accepts: { scheme: "exact", network, payTo: options.sellerAddress, price: `$${route.priceUsd}` },
        description: route.description,
        mimeType: "application/json",
      },
    ]),
  );

  const app = new Hono();

  const marketEnvironment = options.marketEnvironment ?? "production";
  app.get("/health", (c) => c.json({ ok: true, service: "@mandate/signals", marketEnvironment }));

  app.get("/v1/resources", (c) => {
    const origin = new URL(c.req.url).origin;
    const catalog: ResourceCatalog = {
      x402Version: 2,
      seller: options.sellerAddress,
      network,
      facilitator: options.facilitator ? "custom" : facilitatorUrl,
      resources: routes.map((route) => ({
        method: route.method,
        path: route.path,
        url: `${origin}${route.path}`,
        priceUsd: route.priceUsd,
        amount: parseUnits(route.priceUsd, ARC_TESTNET.usdcDecimals).toString(),
        asset: ARC_TESTNET.usdc,
        scheme: "exact",
        settlement: "GatewayWalletBatched",
        mimeType: "application/json",
        description: route.description,
        ...(route.query === undefined ? {} : { query: route.query }),
        ...(route.responseSchema === undefined ? {} : { responseSchema: route.responseSchema }),
        exampleResponse: route.exampleResponse,
      })),
    };
    return c.json(catalog);
  });

  // Free refusals first: a request the seller cannot serve never gets a 402, so the buyer never signs.
  for (const route of routes) {
    const { precheck } = route;
    if (precheck === undefined) continue;
    const beforePayment: MiddlewareHandler = async (c, next) => {
      const refusal = await precheck(c);
      if (refusal !== undefined) return refusal;
      await next();
      return undefined;
    };
    app.use(route.path, beforePayment);
  }

  app.use(paymentMiddleware(routesConfig, resourceServer));

  for (const route of routes) {
    app.get(route.path, route.handler);
  }

  return app;
}
