import { describe, expect, it } from "vitest";
import {
  describeReason,
  INTENT_STATUSES,
  intentStatusFromCode,
  isReasonCode,
  REASON_CODES,
  REASONS,
  verdictFromCode,
  verdictToCode,
} from "../src";

describe("verdict codes", () => {
  it("matches the contract's uint8 encoding", () => {
    expect(verdictFromCode(0)).toBe("approved");
    expect(verdictFromCode(1)).toBe("needs_approval");
    expect(verdictFromCode(2)).toBe("rejected");
    expect(verdictToCode("needs_approval")).toBe(1);
    expect(() => verdictFromCode(3)).toThrow(RangeError);
  });
});

describe("reason codes", () => {
  it("has the six fixed codes, each with a label and a one-sentence explanation", () => {
    expect(REASON_CODES).toEqual([
      "PAUSED",
      "CATEGORY_NOT_ALLOWED",
      "OVER_MAX_TRADE",
      "OVER_BUDGET",
      "DAILY_LOSS_LIMIT",
      "REJECTED_BY_OWNER",
    ]);
    for (const code of REASON_CODES) {
      const { label, explanation } = REASONS[code];
      expect(label.length).toBeGreaterThan(0);
      expect(explanation).toMatch(/^[A-Z][^.]*\.$/);
      expect(explanation).not.toContain("—");
    }
  });

  it("describes unknown reasons without throwing", () => {
    expect(isReasonCode("OVER_BUDGET")).toBe(true);
    expect(isReasonCode("SOMETHING_NEW")).toBe(false);
    expect(describeReason("OVER_BUDGET")).toBe(REASONS.OVER_BUDGET);
    expect(describeReason("SOMETHING_NEW").label).toBe("SOMETHING_NEW");
    expect(describeReason("").label).toBe("Unknown");
  });
});

describe("intent status codes", () => {
  it("matches the contract's Status enum order", () => {
    expect(INTENT_STATUSES).toEqual(["none", "needs_approval", "approved", "rejected", "filled", "unfilled"]);
    expect(intentStatusFromCode(4)).toBe("filled");
    expect(() => intentStatusFromCode(6)).toThrow(RangeError);
  });
});
