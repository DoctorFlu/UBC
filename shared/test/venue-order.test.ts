import { describe, expect, it } from "vitest";

import { clientOrderIdFor, venueOrderRecordSchema } from "../src";

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
  it("names the chain, the contract's first digits, a digest of its deployment and the intent", () => {
    expect(clientOrderIdFor(deployment(), 7)).toBe("mandate-5042002-5fbdb231-3820591c5217-7");
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
    // One venue account serves every mandate's contract: printed prefixes alone could be made to meet.
    const lookalike = "0x5fbdb231ffffffffffffffffffffffffffffffff";
    const theirs = clientOrderIdFor(deployment({ policy: lookalike }), 7);
    expect(theirs.slice(0, "mandate-5042002-5fbdb231".length)).toBe("mandate-5042002-5fbdb231");
    expect(theirs).not.toBe(clientOrderIdFor(deployment(), 7));
  });

  it("differs between chains", () => {
    expect(clientOrderIdFor(deployment({ chainId: 1 }), 7)).not.toBe(clientOrderIdFor(deployment(), 7));
  });

  it("fits the journal's id format at the largest chain id and intent id", () => {
    const id = clientOrderIdFor(
      deployment({ chainId: Number.MAX_SAFE_INTEGER, deployBlockHash: `0x${"ff".repeat(32)}` }),
      Number.MAX_SAFE_INTEGER,
    );
    expect(id.length).toBe(63);
    expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(id).success).toBe(true);
  });

  it("leaves ids journalled in earlier forms valid", () => {
    for (const id of ["mandate-5042002-5fbdb231-0", "mandate-5042002-5fbdb231-a1b2c3d4-0"]) {
      expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(id).success, id).toBe(true);
    }
  });
});
