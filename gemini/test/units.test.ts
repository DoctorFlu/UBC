import { describe, expect, it } from "vitest";
import { scaleDecimal, toCents, toHundredths } from "../src/index";

describe("scaleDecimal", () => {
  it("scales exact values without floating point", () => {
    expect(scaleDecimal("0.41", 2, "exact")).toBe(41n);
    expect(scaleDecimal("0.8", 2, "exact")).toBe(80n);
    expect(scaleDecimal("64000", 2, "exact")).toBe(6_400_000n);
    expect(scaleDecimal("64740.56000", 2, "exact")).toBe(6_474_056n);
    expect(scaleDecimal("-1.5", 2, "exact")).toBe(-150n);
  });

  it("rejects values with extra precision when exact", () => {
    expect(scaleDecimal("0.415", 2, "exact")).toBeNull();
  });

  it("rounds in the requested direction", () => {
    expect(scaleDecimal("0.411", 2, "up")).toBe(42n);
    expect(scaleDecimal("0.419", 2, "down")).toBe(41n);
    expect(scaleDecimal("0.415", 2, "half-up")).toBe(42n);
    expect(scaleDecimal("0.4149", 2, "half-up")).toBe(41n);
    expect(scaleDecimal("-0.411", 2, "up")).toBe(-41n);
    expect(scaleDecimal("-0.411", 2, "down")).toBe(-42n);
    expect(scaleDecimal("-0.415", 2, "half-up")).toBe(-42n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "abc", "1e5", "0x10", "1.2.3", "NaN"]) {
      expect(scaleDecimal(bad, 2, "half-up")).toBeNull();
    }
  });
});

describe("toCents and toHundredths", () => {
  it("handles missing values", () => {
    expect(toCents(undefined, "up")).toBeNull();
    expect(toCents(null, "up")).toBeNull();
    expect(toCents("", "up")).toBeNull();
    expect(toHundredths(undefined)).toBeNull();
  });

  it("converts book amounts to hundredths of a contract, rounding down", () => {
    expect(toHundredths("250.0")).toBe(25_000);
    expect(toHundredths("0.019")).toBe(1);
    expect(toHundredths("-1")).toBeNull();
  });
});
