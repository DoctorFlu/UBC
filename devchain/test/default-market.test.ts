/**
 * `dev:propose` without --market proposes a strike Gemini lists now, so the simulated executor can fill it.
 * The Gemini client is a fake, so no network is needed.
 */
import { describe, expect, it } from "vitest";
import { GeminiError, type GetLadderOptions, type Ladder, type LadderRung } from "@mandate/gemini";
import { pickAtTheMoneyRung, resolveDefaultMarket } from "../src";

function rung(strikeDollars: number, marketState: string | null = "open"): LadderRung {
  return {
    strikeCents: strikeDollars * 100,
    instrumentSymbol: `GEMI-BTC2611272200-HI${strikeDollars.toString()}`,
    label: null,
    marketState,
    yesBidCents: null,
    yesAskCents: null,
    noBuyCents: null,
    noSellCents: null,
    lastTradeCents: null,
  };
}

function ladder(spotDollars: number, rungs: LadderRung[]): Ladder {
  return {
    asset: "BTC",
    eventTicker: "BTC2611272200",
    title: "BTC price on Nov 27",
    kind: "weekly",
    expiry: "2026-11-27T22:00:00.000Z",
    settlementIndex: null,
    spot: {
      asset: "BTC",
      symbol: "btcusd",
      bidCents: null,
      askCents: null,
      lastCents: null,
      midCents: spotDollars * 100,
      fetchedAt: "2026-11-15T12:00:00.000Z",
    },
    rungs,
    fetchedAt: "2026-11-15T12:00:00.000Z",
  };
}

describe("pickAtTheMoneyRung", () => {
  it("picks the open strike nearest spot", () => {
    const picked = pickAtTheMoneyRung(ladder(65_400, [rung(64_000), rung(65_000), rung(66_000)]));
    expect(picked?.strikeCents).toBe(6_500_000);
  });

  it("skips strikes that are not open", () => {
    const picked = pickAtTheMoneyRung(
      ladder(65_400, [rung(64_000), rung(65_000, "closed"), rung(66_000, null), rung(67_000)]),
    );
    expect(picked?.strikeCents).toBe(6_400_000);
  });

  it("takes the lower strike when two are equally near", () => {
    const picked = pickAtTheMoneyRung(ladder(65_500, [rung(66_000), rung(65_000)]));
    expect(picked?.strikeCents).toBe(6_500_000);
  });

  it("returns null when no strike is open", () => {
    expect(pickAtTheMoneyRung(ladder(65_000, [rung(65_000, "closed")]))).toBeNull();
  });
});

describe("resolveDefaultMarket", () => {
  it("asks for the soonest open weekly BTC ladder and returns its at-the-money strike", async () => {
    const asked: GetLadderOptions[] = [];
    const picked = await resolveDefaultMarket({
      getLadder: (options) => {
        asked.push(options);
        return Promise.resolve(ladder(91_200, [rung(90_000), rung(91_000), rung(92_000)]));
      },
    });
    expect(asked).toEqual([{ asset: "BTC", horizon: "weekly" }]);
    expect(picked).toEqual({
      market: "GEMI-BTC2611272200-HI91000",
      eventTicker: "BTC2611272200",
      expiry: "2026-11-27T22:00:00.000Z",
      strikeCents: 9_100_000,
      spotCents: 9_120_000,
    });
  });

  it("passes on Gemini's error when Gemini cannot be reached", async () => {
    const down = new GeminiError("network", "fetch failed");
    await expect(resolveDefaultMarket({ getLadder: () => Promise.reject(down) })).rejects.toBe(down);
  });

  it("throws when the ladder has no open strike", async () => {
    await expect(
      resolveDefaultMarket({ getLadder: () => Promise.resolve(ladder(65_000, [rung(65_000, "closed")])) }),
    ).rejects.toThrow("has no open strike");
  });
});
