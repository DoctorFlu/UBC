import { ARC_TESTNET } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { createSignalsApp, type ResourceCatalog } from "../src/index";
import { FakeGatewayFacilitator } from "../src/testing";

const SELLER = "0x6969C08b342f099377956e2143f3F13E91a4907D";

function makeApp() {
  const facilitator = new FakeGatewayFacilitator();
  const app = createSignalsApp({ sellerAddress: SELLER, facilitator });
  return { app, facilitator };
}

interface PaymentRequired {
  x402Version: number;
  resource: { url: string; mimeType: string };
  accepts: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: { name: string; version: string; verifyingContract: string };
  }[];
}

describe("signals app", () => {
  it("serves /health for free", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "@mandate/signals" });
  });

  it("describes the paid resource on the free discovery route", async () => {
    const { app } = makeApp();
    const res = await app.request("http://signals.test/v1/resources");
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as ResourceCatalog;
    expect(catalog.seller).toBe(SELLER);
    expect(catalog.network).toBe("eip155:5042002");
    expect(catalog.resources).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/v1/signal/hello",
        url: "http://signals.test/v1/signal/hello",
        priceUsd: "0.001",
        amount: "1000",
        asset: ARC_TESTNET.usdc,
        scheme: "exact",
        settlement: "GatewayWalletBatched",
      }),
    ]);
  });

  it("answers an unpaid request with 402 and well-formed Gateway payment requirements", async () => {
    const { app, facilitator } = makeApp();
    const res = await app.request("http://signals.test/v1/signal/hello");
    expect(res.status).toBe(402);

    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const required = JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")) as PaymentRequired;
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe("http://signals.test/v1/signal/hello");
    expect(required.accepts).toHaveLength(1);
    const [option] = required.accepts;
    expect(option).toMatchObject({
      scheme: "exact",
      network: "eip155:5042002",
      amount: "1000",
      asset: ARC_TESTNET.usdc,
      payTo: SELLER,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: ARC_TESTNET.gatewayWallet.toLowerCase(),
      },
    });
    // Gateway rejects authorizations valid for less than 7 days.
    expect(option?.maxTimeoutSeconds).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);

    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("rejects a garbage payment header without serving the resource", async () => {
    const { app, facilitator } = makeApp();
    const res = await app.request("http://signals.test/v1/signal/hello", {
      headers: { "Payment-Signature": "not-base64-json" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toContain("hello from @mandate/signals");
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});
