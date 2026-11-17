import { describe, expect, it } from "vitest";

import { clientOrderIdFor, venueOrderRecordSchema } from "../src";

describe("clientOrderIdFor (#95: one venue account, every mandate's contract)", () => {
  const policy = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  it("is the same for the same intent on the same contract, however the address is spelt", () => {
    expect(clientOrderIdFor(5_042_002, policy, 7)).toBe("mandate-a36a070dc34de39d1842534d-7");
    expect(clientOrderIdFor(5_042_002, policy.toLowerCase(), 7)).toBe(clientOrderIdFor(5_042_002, policy, 7));
  });

  it("differs between contracts that share the address's first digits, and between chains", () => {
    // An address ground to match another's first 8 hex digits: the old form gave both the same id.
    const lookalike = "0x5fbdb231ffffffffffffffffffffffffffffffff";
    expect(clientOrderIdFor(5_042_002, lookalike, 7)).not.toBe(clientOrderIdFor(5_042_002, policy, 7));
    expect(clientOrderIdFor(1, policy, 7)).not.toBe(clientOrderIdFor(5_042_002, policy, 7));
  });

  it("fits the record's id rule for any intent id", () => {
    const id = clientOrderIdFor(5_042_002, policy, Number.MAX_SAFE_INTEGER);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(venueOrderRecordSchema.shape.clientOrderId.safeParse(id).success).toBe(true);
  });
});
