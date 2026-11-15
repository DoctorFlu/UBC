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
  it("matches the previewTrade uint8 encoding", () => {
    expect(verdictFromCode(0)).toBe("approved");
    expect(verdictFromCode(1)).toBe("needs_approval");
    expect(verdictFromCode(2)).toBe("rejected");
    expect(verdictToCode("needs_approval")).toBe(1);
    expect(() => verdictFromCode(3)).toThrow(RangeError);
  });
});

describe("rejection reasons", () => {
  it("are the contract's exact strings, each with a label and a one-sentence explanation", () => {
    expect(REASON_CODES).toEqual([
      "agent paused",
      "zero amount",
      "daily loss limit reached",
      "over max trade size",
      "category not allowed",
      "over budget",
      "rejected by user",
    ]);
    for (const code of REASON_CODES) {
      const { label, explanation } = REASONS[code];
      expect(label.length).toBeGreaterThan(0);
      expect(explanation).toMatch(/^[A-Z][^]*\.$/);
      expect(explanation.split(". ")).toHaveLength(1);
      expect(explanation).not.toContain("—"); // no em dashes in user-facing text
    }
  });

  it("describes unknown reasons without throwing", () => {
    expect(isReasonCode("over budget")).toBe(true);
    expect(isReasonCode("OVER_BUDGET")).toBe(false);
    expect(describeReason("over budget")).toBe(REASONS["over budget"]);
    expect(describeReason("something new").label).toBe("something new");
    expect(describeReason("").label).toBe("Unknown");
  });
});

describe("intent status codes", () => {
  it("matches the contract's Status enum order and names", () => {
    expect(INTENT_STATUSES).toEqual(["none", "approved", "needs_approval", "rejected", "executed", "failed"]);
    expect(intentStatusFromCode(2)).toBe("needs_approval");
    expect(intentStatusFromCode(4)).toBe("executed");
    expect(() => intentStatusFromCode(6)).toThrow(RangeError);
  });
});
