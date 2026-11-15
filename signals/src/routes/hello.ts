import type { PaidRoute } from "../paid-route";

/** Placeholder paid resource used to prove the x402 flow end to end (issue #6). */
export const helloRoute: PaidRoute = {
  method: "GET",
  path: "/v1/signal/hello",
  priceUsd: "0.001",
  description: "Hello-world paid resource that proves the Nanopayments flow on Arc testnet.",
  exampleResponse: { message: "hello from @mandate/signals", servedAt: "2026-11-15T00:00:00.000Z" },
  handler: (c) => c.json({ message: "hello from @mandate/signals", servedAt: new Date().toISOString() }),
};
