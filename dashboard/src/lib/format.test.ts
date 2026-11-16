import { describe, expect, it } from "vitest";

import {
  formatContractPrice,
  formatContractsHundredths,
  formatCount,
  formatPercentBps,
  formatTimeUtc,
  formatUsdCents,
  formatUsdCentsDelta,
  parseUsdToCents,
  shareBps,
  shortenHex,
} from "./format";

describe("parseUsdToCents", () => {
  it("reads whole dollars, cents and grouped thousands exactly", () => {
    expect(parseUsdToCents("75")).toBe(7500);
    expect(parseUsdToCents("$0.05")).toBe(5);
    expect(parseUsdToCents("1,250.5")).toBe(125_050);
    expect(parseUsdToCents(" 0.1 ")).toBe(10);
    expect(parseUsdToCents("0.29")).toBe(29);
  });

  it("round-trips with formatUsdCents", () => {
    expect(parseUsdToCents(formatUsdCents(123_456))).toBe(123_456);
  });

  it("rejects what it cannot read exactly", () => {
    for (const bad of ["", "-5", "1.234", "1,25", "12a", "1e3", ".5", "$"]) {
      expect(parseUsdToCents(bad)).toBeNull();
    }
    expect(parseUsdToCents("9".repeat(20))).toBeNull();
  });
});

const MINUS = "−";

describe("formatUsdCents", () => {
  it("formats integer cents exactly", () => {
    expect(formatUsdCents(0)).toBe("$0.00");
    expect(formatUsdCents(5)).toBe("$0.05");
    expect(formatUsdCents(100)).toBe("$1.00");
    expect(formatUsdCents(123456)).toBe("$1,234.56");
    expect(formatUsdCents(100_000_000)).toBe("$1,000,000.00");
  });

  it("uses the minus sign for negatives", () => {
    expect(formatUsdCents(-5)).toBe(`${MINUS}$0.05`);
    expect(formatUsdCents(-123456)).toBe(`${MINUS}$1,234.56`);
  });

  it("handles bigint amounts beyond the safe integer range", () => {
    expect(formatUsdCents(123456789012345678901n)).toBe("$1,234,567,890,123,456,789.01");
  });

  it("supports sign display options", () => {
    expect(formatUsdCents(250, { sign: "always" })).toBe("+$2.50");
    expect(formatUsdCents(0, { sign: "always" })).toBe("$0.00");
    expect(formatUsdCents(-250, { sign: "never" })).toBe("$2.50");
  });

  it("can trim whole cents", () => {
    expect(formatUsdCents(5000, { trimWholeCents: true })).toBe("$50");
    expect(formatUsdCents(5001, { trimWholeCents: true })).toBe("$50.01");
  });

  it("rejects fractional and unsafe numbers instead of rounding", () => {
    expect(() => formatUsdCents(1.5)).toThrow(RangeError);
    expect(() => formatUsdCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => formatUsdCents(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatUsdCentsDelta", () => {
  it("always shows the direction", () => {
    expect(formatUsdCentsDelta(1250)).toBe("+$12.50");
    expect(formatUsdCentsDelta(-350)).toBe(`${MINUS}$3.50`);
    expect(formatUsdCentsDelta(0)).toBe("$0.00");
  });
});

describe("formatContractPrice", () => {
  it("formats whole-cent prices", () => {
    expect(formatContractPrice(37)).toBe("37¢");
    expect(formatContractPrice(0)).toBe("0¢");
    expect(formatContractPrice(100)).toBe("100¢");
  });

  it("rejects prices outside 0 to 100", () => {
    expect(() => formatContractPrice(101)).toThrow(RangeError);
    expect(() => formatContractPrice(-1)).toThrow(RangeError);
  });
});

describe("formatPercentBps", () => {
  it("formats basis points exactly", () => {
    expect(formatPercentBps(1250)).toBe("12.50%");
    expect(formatPercentBps(5)).toBe("0.05%");
    expect(formatPercentBps(10_000)).toBe("100.00%");
    expect(formatPercentBps(1_234_567)).toBe("12,345.67%");
  });

  it("rounds half away from zero with fewer digits", () => {
    expect(formatPercentBps(1250, { fractionDigits: 0 })).toBe("13%");
    expect(formatPercentBps(1249, { fractionDigits: 0 })).toBe("12%");
    expect(formatPercentBps(-1250, { fractionDigits: 0 })).toBe(`${MINUS}13%`);
    expect(formatPercentBps(1255, { fractionDigits: 1 })).toBe("12.6%");
  });

  it("supports signs and treats a rounded zero as unsigned", () => {
    expect(formatPercentBps(300, { sign: "always" })).toBe("+3.00%");
    expect(formatPercentBps(-300)).toBe(`${MINUS}3.00%`);
    expect(formatPercentBps(-4, { fractionDigits: 0 })).toBe("0%");
  });
});

describe("shareBps", () => {
  it("rounds down so a limit is never shown reached early", () => {
    expect(shareBps(41_250, 100_000)).toBe(4125);
    expect(shareBps(99_999, 100_000)).toBe(9999);
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(5, 0)).toBe(0);
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1200)).toBe("1,200");
    expect(formatCount(-7)).toBe(`${MINUS}7`);
  });
});

describe("formatContractsHundredths", () => {
  it("keeps every hundredth and never rounds to whole contracts", () => {
    expect(formatContractsHundredths(2930)).toBe("29.30");
    expect(formatContractsHundredths(2905)).toBe("29.05");
    expect(formatContractsHundredths(1)).toBe("0.01");
    expect(formatContractsHundredths(99)).toBe("0.99");
    expect(formatContractsHundredths(5000)).toBe("50");
    expect(formatContractsHundredths(0)).toBe("0");
    expect(formatContractsHundredths(123_456)).toBe("1,234.56");
  });

  it("refuses fractions of a hundredth and negatives", () => {
    expect(() => formatContractsHundredths(12.5)).toThrow(RangeError);
    expect(() => formatContractsHundredths(-1)).toThrow(RangeError);
  });
});

describe("formatTimeUtc", () => {
  it("renders in UTC regardless of the local zone", () => {
    expect(formatTimeUtc("2026-11-15T14:02:11.000Z")).toBe("14:02:11 UTC");
  });
});

describe("shortenHex", () => {
  it("keeps the head and tail", () => {
    expect(shortenHex("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
    expect(shortenHex("0x1234")).toBe("0x1234");
  });
});
