import { ARC_TESTNET } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { readSignalsConfig } from "../src/config";

const SELLER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("readSignalsConfig", () => {
  it("treats blank optional values as unset, as a hosted env file leaves them", () => {
    const config = readSignalsConfig({
      X402_SELLER_ADDRESS: SELLER,
      X402_FACILITATOR_URL: " ",
      SIGNALS_PORT: "",
      SIGNALS_HEDGE_PRICE_USD: "",
      SIGNALS_ASSETS: "",
      SIGNALS_FAIR_BAND_CENTS: "",
      SIGNALS_VOL_WINDOW_HOURS: "",
    });
    expect(config).toMatchObject({
      sellerAddress: SELLER,
      facilitatorUrl: ARC_TESTNET.gatewayApiUrl,
      port: 4021,
      hedge: { priceUsd: "0.001", fairBandCents: 2, volWindowHours: 168 },
    });
  });

  it("uses a facilitator URL that is set", () => {
    const config = readSignalsConfig({
      X402_SELLER_ADDRESS: SELLER,
      X402_FACILITATOR_URL: "https://gateway.example",
    });
    expect(config.facilitatorUrl).toBe("https://gateway.example");
  });

  it("refuses to start without a seller", () => {
    expect(() => readSignalsConfig({})).toThrow(/X402_SELLER_ADDRESS or X402_SELLER_PRIVATE_KEY/);
  });
});
