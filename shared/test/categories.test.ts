import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES_MASK,
  categoriesFromMask,
  Category,
  categoryFromGemini,
  categoryLabel,
  categoryMask,
  isCategoryAllowed,
} from "../src";

describe("categories", () => {
  it("uses the documented bit positions", () => {
    expect(Category).toEqual({
      Crypto: 0,
      Sports: 1,
      Economics: 2,
      Commodities: 3,
      Weather: 4,
      Politics: 5,
      Other: 6,
    });
    expect(ALL_CATEGORIES_MASK).toBe(0b1111111);
  });

  it("maps Gemini category strings, ignoring case, with Other as the fallback", () => {
    expect(categoryFromGemini("Crypto")).toBe(Category.Crypto);
    expect(categoryFromGemini("Sports")).toBe(Category.Sports);
    expect(categoryFromGemini("Economics")).toBe(Category.Economics);
    expect(categoryFromGemini("Commodities")).toBe(Category.Commodities);
    expect(categoryFromGemini("Weather")).toBe(Category.Weather);
    expect(categoryFromGemini(" politics ")).toBe(Category.Politics);
    expect(categoryFromGemini("Culture")).toBe(Category.Other);
    expect(categoryFromGemini("")).toBe(Category.Other);
  });

  it("builds and reads masks", () => {
    expect(categoryMask([Category.Crypto])).toBe(1);
    expect(categoryMask([Category.Crypto, Category.Weather, Category.Crypto])).toBe(0b10001);
    expect(categoriesFromMask(0b10001)).toEqual([Category.Crypto, Category.Weather]);
    expect(() => categoryMask([7])).toThrow(RangeError);
  });

  it("checks bits like the contract, beyond 32 bits and for out-of-range ids", () => {
    expect(isCategoryAllowed(0b101, 0)).toBe(true);
    expect(isCategoryAllowed(0b101, 1)).toBe(false);
    expect(isCategoryAllowed(2 ** 40, 40)).toBe(true);
    expect(isCategoryAllowed(2 ** 40, 8)).toBe(false);
    expect(isCategoryAllowed(Number.MAX_SAFE_INTEGER, 52)).toBe(true);
    expect(isCategoryAllowed(Number.MAX_SAFE_INTEGER, 53)).toBe(false);
    expect(isCategoryAllowed(Number.MAX_SAFE_INTEGER, 255)).toBe(false);
    expect(isCategoryAllowed(0b1, 256)).toBe(false);
  });

  it("labels known and unknown ids", () => {
    expect(categoryLabel(Category.Weather)).toBe("Weather");
    expect(categoryLabel(42)).toBe("Unknown (42)");
  });
});
