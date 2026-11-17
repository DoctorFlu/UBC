import { Category } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { describeMarket } from "./markets";

// Symbols as Gemini's public API listed them (GET /v1/prediction-markets/events, November 2026).
const BTC_LADDER = "GEMI-BTC2611152100-HI64300";
const NBA_GAME = "GEMI-NBA-2611170000-ORL-BOS-M-BOS";
const GOLF_TOP_10 = "GEMI-GOLF-AUS-T10-20261115-PAN";

describe("describeMarket", () => {
  it("reads a crypto ladder symbol in words, with its settle time", () => {
    const market = describeMarket(BTC_LADDER, Category.Crypto);
    expect(market).toMatchObject({
      title: "BTC $64,300 or above",
      parsed: true,
      isSymbol: true,
      settles: "Nov 15, 21:00 UTC",
    });
  });

  it("names any other Gemini market by the intent's category, never by its raw symbol", () => {
    for (const symbol of [NBA_GAME, GOLF_TOP_10]) {
      const market = describeMarket(symbol, Category.Sports);
      expect(market).toMatchObject({ title: "Sports market", parsed: false, isSymbol: true, symbol });
      expect(market.settles).toBeNull();
    }
    expect(describeMarket(NBA_GAME, Category.Politics).title).toBe("Politics market");
  });

  it("falls back to a plain Gemini market when the category is unknown or Other", () => {
    expect(describeMarket(NBA_GAME).title).toBe("Gemini market");
    expect(describeMarket(NBA_GAME, Category.Other).title).toBe("Gemini market");
    expect(describeMarket(NBA_GAME, 9).title).toBe("Gemini market");
  });

  it("still says Not a Gemini market for text that is not a symbol, whatever the category", () => {
    const market = describeMarket("Buy everything now", Category.Sports);
    expect(market).toMatchObject({ title: "Not a Gemini market", parsed: false, isSymbol: false });
    expect(market.preview).toBe("Buy everything now");
  });
});
