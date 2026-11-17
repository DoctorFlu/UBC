import { describe, expect, it } from "vitest";
import {
  affordableHundredths,
  estimatedFeeCents,
  orderCostCents,
  predictionFeeCents,
  worstCaseSpendCents,
} from "../src/fees";

describe("Gemini's prediction-market fees", () => {
  it("matches every example on Gemini's fee page", () => {
    // https://www.gemini.com/fees/predictions, "Fee Examples": role, price, contracts, rate, fee.
    expect(predictionFeeCents(10_000, 10, "maker")).toBe(16);
    expect(predictionFeeCents(10_000, 50, "maker")).toBe(44);
    expect(predictionFeeCents(10_000, 40, "taker")).toBe(168);
    expect(predictionFeeCents(10_000, 90, "taker")).toBe(63);
  });

  it("rounds up to the next cent, so any fill pays at least a cent", () => {
    expect(predictionFeeCents(100, 1, "taker")).toBe(1); // $0.000693
    expect(predictionFeeCents(100, 97, "taker")).toBe(1); // $0.002037
    expect(predictionFeeCents(0, 50, "taker")).toBe(0);
    expect(() => predictionFeeCents(100, 0, "taker")).toThrow(RangeError);
    expect(() => predictionFeeCents(1.5, 50, "taker")).toThrow(RangeError);
  });

  it("costs an order at its limit, rounded up, and adds the taker fee for the worst case", () => {
    expect(orderCostCents(1, 37)).toBe(1); // 0.37c
    expect(orderCostCents(100, 97)).toBe(97);
    expect(worstCaseSpendCents(100, 97)).toBe(98);
  });

  it("sizes the largest order whose cost and worst-case fee fit the amount", () => {
    // Without fees $10.00 at 50c buys 20 contracts; with the taker fee, 19.32 (966c and a 34c fee).
    const quantity = affordableHundredths(1_000, 50, 1);
    expect(quantity).toBe(1_932);
    expect(worstCaseSpendCents(quantity, 50)).toBeLessThanOrEqual(1_000);
    expect(worstCaseSpendCents(quantity + 1, 50)).toBeGreaterThan(1_000);
    // On a whole-contract grid.
    expect(affordableHundredths(1_000, 50, 100)).toBe(1_900);
    // $0.98 at 97c: one contract (97c and a 1c fee); $0.97 is a cent short.
    expect(affordableHundredths(98, 97, 100)).toBe(100);
    expect(affordableHundredths(97, 97, 100)).toBe(0);
  });

  it("never sizes over the amount, at any price, amount or grid", () => {
    for (const step of [1, 100]) {
      for (let price = 1; price <= 99; price += 7) {
        for (const amount of [1, 2, 3, 50, 99, 100, 1_000, 2_499, 100_000]) {
          const quantity = affordableHundredths(amount, price, step);
          expect(quantity % step).toBe(0);
          if (quantity > 0) expect(worstCaseSpendCents(quantity, price)).toBeLessThanOrEqual(amount);
          expect(worstCaseSpendCents(quantity + step, price)).toBeGreaterThan(amount);
        }
      }
    }
  });

  it("estimates the fee on fills at the taker rate and their average price, the same as at a whole-cent price", () => {
    // The sandbox fill: 1 contract at 97c paid 1c (0.2c at the taker rate, rounded up).
    expect(estimatedFeeCents(100, 9_700)).toBe(1);
    // 10 contracts at 97c: 2.037c, so 3c at the taker rate (the maker rate would give 1c).
    expect(estimatedFeeCents(1_000, 9_700)).toBe(3);
    for (const [hundredths, cents] of [
      [1_000, 50],
      [10_000, 40],
      [10_000, 90],
      [37, 13],
    ] as const) {
      expect(estimatedFeeCents(hundredths, cents * 100)).toBe(predictionFeeCents(hundredths, cents, "taker"));
    }
    // Between cents: 12 contracts at an average of 30.5c, 0.07 x 12 x 0.305 x 0.695 = /bin/zsh.178.
    expect(estimatedFeeCents(1_200, 3_050)).toBe(18);
    expect(estimatedFeeCents(0, 5_000)).toBe(0);
    expect(() => estimatedFeeCents(100, 0)).toThrow(RangeError);
    expect(() => estimatedFeeCents(100, 10_000)).toThrow(RangeError);
  });
});
