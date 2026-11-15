import { describe, expect, it } from "vitest";
import {
  amountFromQuantity,
  dollarsToCents,
  dollarsToLimitPrice,
  formatCents,
  formatQuantity,
  limitPriceToDollars,
  quantityFromAmount,
  quantityHundredthsFromAmount,
  toSafeNumber,
  UnitError,
} from "../src";

describe("quantity and amount", () => {
  it("floors the quantity to 2 decimals", () => {
    expect(quantityFromAmount(1000, 65)).toBe(15.38); // 15.3846...
    expect(quantityFromAmount(2500, 50)).toBe(50);
    expect(quantityFromAmount(1, 99)).toBe(0.01); // 0.0101...
    expect(quantityFromAmount(0, 50)).toBe(0);
    expect(quantityHundredthsFromAmount(1000, 65)).toBe(1538);
  });

  it("rounds the amount for a quantity up to the next cent", () => {
    expect(amountFromQuantity(15.38, 65)).toBe(1000); // 999.7
    expect(amountFromQuantity(50, 50)).toBe(2500);
    expect(amountFromQuantity(0.01, 99)).toBe(1); // 0.99
    expect(amountFromQuantity(0.29, 7)).toBe(3); // 2.03, float-safe
  });

  it("never spends more than the amount when converting there and back", () => {
    for (let amount = 1; amount <= 3000; amount += 7) {
      for (const price of [1, 7, 33, 50, 65, 99]) {
        const quantity = quantityFromAmount(amount, price);
        expect(amountFromQuantity(quantity, price)).toBeLessThanOrEqual(amount);
      }
    }
  });

  it("rejects invalid prices, amounts and quantities", () => {
    expect(() => quantityFromAmount(100, 0)).toThrow(UnitError);
    expect(() => quantityFromAmount(100, 100)).toThrow(UnitError);
    expect(() => quantityFromAmount(100, 50.5)).toThrow(UnitError);
    expect(() => quantityFromAmount(-1, 50)).toThrow(UnitError);
    expect(() => quantityFromAmount(1.5, 50)).toThrow(UnitError);
    expect(() => amountFromQuantity(1.234, 50)).toThrow(UnitError);
    expect(() => amountFromQuantity(-1, 50)).toThrow(UnitError);
  });

  it("formats quantities for Gemini", () => {
    expect(formatQuantity(15.38)).toBe("15.38");
    expect(formatQuantity(50)).toBe("50.00");
  });
});

describe("prices and dollars", () => {
  it("converts limit prices to and from Gemini dollar strings", () => {
    expect(limitPriceToDollars(65)).toBe("0.65");
    expect(limitPriceToDollars(1)).toBe("0.01");
    expect(dollarsToLimitPrice("0.65")).toBe(65);
    expect(dollarsToLimitPrice(0.07)).toBe(7);
    expect(() => dollarsToLimitPrice("1.00")).toThrow(UnitError);
    expect(() => dollarsToLimitPrice("0.655")).toThrow(UnitError);
  });

  it("parses dollars to cents exactly", () => {
    expect(dollarsToCents("12.34")).toBe(1234);
    expect(dollarsToCents("$200")).toBe(20000);
    expect(dollarsToCents("0.5")).toBe(50);
    expect(dollarsToCents(25)).toBe(2500);
    expect(dollarsToCents("-1.5")).toBe(-150);
    expect(() => dollarsToCents("1.234")).toThrow(UnitError);
    expect(() => dollarsToCents("abc")).toThrow(UnitError);
  });

  it("formats cents as dollars", () => {
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-150)).toBe("-$1.50");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(() => formatCents(1.5)).toThrow(UnitError);
  });
});

describe("toSafeNumber", () => {
  it("converts safe bigints and refuses larger ones", () => {
    expect(toSafeNumber(42n)).toBe(42);
    expect(toSafeNumber(-42n)).toBe(-42);
    expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "budgetCents")).toThrow(/budgetCents/);
    expect(() => toSafeNumber(2n ** 256n - 1n)).toThrow(UnitError);
  });
});
