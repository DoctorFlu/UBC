import { describe, expect, it } from "vitest";
import { clientOrderIdFor, venueOrderRecordSchema } from "../src";

const POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("clientOrderIdFor", () => {
  it("names the chain, the contract, its deploy block and the intent", () => {
    const id = clientOrderIdFor(
      { chainId: 5_042_002, policy: POLICY, deployBlockHash: `0xA1B2C3D4${"0".repeat(56)}` },
      7,
    );
    expect(id).toBe("mandate-5042002-5fbdb231-a1b2c3d4-7");
  });

  it("differs between two deployments at the same address, which only the deploy block tells apart (#117)", () => {
    const first = clientOrderIdFor(
      { chainId: 5_042_002, policy: POLICY, deployBlockHash: `0x${"11".repeat(32)}` },
      0,
    );
    const second = clientOrderIdFor(
      { chainId: 5_042_002, policy: POLICY, deployBlockHash: `0x${"22".repeat(32)}` },
      0,
    );
    expect(first).not.toBe(second);
  });

  it("fits the journal's id format at the largest chain id and intent id", () => {
    const id = clientOrderIdFor(
      { chainId: Number.MAX_SAFE_INTEGER, policy: POLICY, deployBlockHash: `0x${"ff".repeat(32)}` },
      Number.MAX_SAFE_INTEGER,
    );
    expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(id).success).toBe(true);
  });

  it("leaves ids journalled before #117 valid", () => {
    expect(venueOrderRecordSchema.shape.clientOrderId.safeParse("mandate-5042002-5fbdb231-0").success).toBe(
      true,
    );
  });
});
