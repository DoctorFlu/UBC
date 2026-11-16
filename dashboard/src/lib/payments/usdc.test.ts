import { describe, expect, it } from "vitest";

import { formatUsdc, parseUsdcAtomic, usdcShareBps } from "./usdc";

describe("formatUsdc", () => {
  it("shows every atomic unit exactly, with at least two decimals", () => {
    expect(formatUsdc("1000")).toBe("0.001 USDC");
    expect(formatUsdc("1")).toBe("0.000001 USDC");
    expect(formatUsdc("20000")).toBe("0.02 USDC");
    expect(formatUsdc("4999000")).toBe("4.999 USDC");
    expect(formatUsdc("0")).toBe("0.00 USDC");
    expect(formatUsdc("1234500000")).toBe("1,234.50 USDC");
    expect(formatUsdc("1000000", { unit: false })).toBe("1.00");
  });

  it("stays exact beyond the range of a float", () => {
    expect(formatUsdc("123456789012345678901234567890")).toBe("123,456,789,012,345,678,901,234.56789 USDC");
  });

  it("refuses anything that is not a whole number of atomic units", () => {
    expect(() => parseUsdcAtomic("0.5")).toThrow(RangeError);
    expect(() => parseUsdcAtomic("01")).toThrow(RangeError);
    expect(() => parseUsdcAtomic("1e6")).toThrow(RangeError);
  });
});

describe("usdcShareBps", () => {
  it("is integer basis points, rounded down", () => {
    expect(usdcShareBps(1000n, 20000n)).toBe(500);
    expect(usdcShareBps(1n, 3n)).toBe(3333);
    expect(usdcShareBps(5n, 0n)).toBe(0);
  });
});
