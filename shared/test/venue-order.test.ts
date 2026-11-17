import { describe, expect, it } from "vitest";

import {
  ClientOrderIdError,
  GEMINI_CLIENT_ORDER_ID_MAX,
  MAX_ORDER_INTENT_ID,
  clientOrderIdFor,
  venueOrderRecordSchema,
} from "../src";

const POLICY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const BLOCK = `0xA1B2C3D4${"0".repeat(56)}`;
const deployment = (
  overrides: Partial<{ chainId: number; policy: string; deployBlockHash: string }> = {},
) => ({
  chainId: 5_042_002,
  policy: POLICY,
  deployBlockHash: BLOCK,
  ...overrides,
});

describe("clientOrderIdFor", () => {
  it("is m-, 20 hex digits of a digest of the deployment, and the intent", () => {
    expect(clientOrderIdFor(deployment(), 7)).toBe("m-3820591c52173a5992cf-7");
  });

  it("is exactly Gemini's 36 characters at the largest intent id it carries, which leaves 13 digits", () => {
    expect(GEMINI_CLIENT_ORDER_ID_MAX).toBe(36);
    expect(MAX_ORDER_INTENT_ID).toBe(9_999_999_999_999);
    const longest = clientOrderIdFor(deployment(), MAX_ORDER_INTENT_ID);
    expect(longest).toBe("m-3820591c52173a5992cf-9999999999999");
    expect(longest).toHaveLength(GEMINI_CLIENT_ORDER_ID_MAX);
    expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(longest).success).toBe(true);
    // The chain id and the address no longer show in the id, so their size cannot push it over.
    const huge = deployment({ chainId: Number.MAX_SAFE_INTEGER, deployBlockHash: `0x${"ff".repeat(32)}` });
    expect(clientOrderIdFor(huge, MAX_ORDER_INTENT_ID)).toHaveLength(GEMINI_CLIENT_ORDER_ID_MAX);
  });

  it("refuses an intent id one past what fits, and anything that is not an intent id", () => {
    for (const intentId of [MAX_ORDER_INTENT_ID + 1, Number.MAX_SAFE_INTEGER, -1, 1.5, Number.NaN]) {
      expect(() => clientOrderIdFor(deployment(), intentId), String(intentId)).toThrow(ClientOrderIdError);
    }
    expect(() => clientOrderIdFor(deployment(), MAX_ORDER_INTENT_ID + 1)).toThrow(
      /intent 10000000000000 does not fit Gemini's 36-character client order id/,
    );
  });

  it("is the same however the address and the block hash are spelt", () => {
    expect(
      clientOrderIdFor(deployment({ policy: POLICY.toLowerCase(), deployBlockHash: BLOCK.toLowerCase() }), 7),
    ).toBe(clientOrderIdFor(deployment(), 7));
  });

  it("differs between two deployments at the same address, which only the deploy block tells apart (#117)", () => {
    const first = clientOrderIdFor(deployment({ deployBlockHash: `0x${"11".repeat(32)}` }), 0);
    const second = clientOrderIdFor(deployment({ deployBlockHash: `0x${"22".repeat(32)}` }), 0);
    expect(first).not.toBe(second);
  });

  it("differs for a contract ground to share the first digits, deployed in the same block (#95)", () => {
    // One venue account serves every mandate's contract: the whole address goes into the digest.
    const lookalike = "0x5fbdb231ffffffffffffffffffffffffffffffff";
    expect(clientOrderIdFor(deployment({ policy: lookalike }), 7)).not.toBe(
      clientOrderIdFor(deployment(), 7),
    );
  });

  it("differs between chains", () => {
    expect(clientOrderIdFor(deployment({ chainId: 1 }), 7)).not.toBe(clientOrderIdFor(deployment(), 7));
  });

  it("leaves ids journalled in earlier forms valid", () => {
    for (const id of [
      "mandate-5042002-5fbdb231-0",
      "mandate-5042002-5fbdb231-a1b2c3d4-0",
      "mandate-5042002-5fbdb231-3820591c5217-0",
    ]) {
      expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(id).success, id).toBe(true);
    }
  });
});
