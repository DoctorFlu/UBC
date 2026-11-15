import { describe, expect, it } from "vitest";
import {
  buildLadder,
  classifyKind,
  eventSchema,
  eventsResponseSchema,
  normalizeBook,
  normalizeEvent,
  normalizeTicker,
  orderBookSchema,
  parseCryptoTicker,
  tickerSchema,
  type SpotPrice,
} from "../src/index";
import { fixture } from "./helpers";

const page = eventsResponseSchema.parse(fixture("events-crypto.json"));
const byTicker = (ticker: string) => {
  const event = page.data.find((e) => e.ticker === ticker);
  if (event === undefined) throw new Error(`missing ${ticker}`);
  return event;
};

describe("parseCryptoTicker", () => {
  it("reads the underlying, duration marker and UTC expiry", () => {
    expect(parseCryptoTicker("BTC2611202200")).toEqual({
      asset: "BTC",
      duration: null,
      expiry: "2026-11-20T22:00:00.000Z",
    });
    expect(parseCryptoTicker("HYPE2611152100")?.asset).toBe("HYPE");
    expect(parseCryptoTicker("BTC05M2611152020")).toEqual({
      asset: "BTC",
      duration: "05M",
      expiry: "2026-11-15T20:20:00.000Z",
    });
    expect(parseCryptoTicker("ETH15M2611152030")?.duration).toBe("15M");
  });

  it("rejects non-crypto tickers and impossible dates", () => {
    expect(parseCryptoTicker("FEDJAN26")).toBeNull();
    expect(parseCryptoTicker("BTC2613312200")).toBeNull();
  });
});

describe("classifyKind", () => {
  it("classifies every recorded crypto series, including the untagged weekly ladder", () => {
    expect(classifyKind(byTicker("BTC2611152100"))).toBe("hourly");
    expect(classifyKind(byTicker("BTC2611152200"))).toBe("daily");
    expect(classifyKind(byTicker("BTC2611202200"))).toBe("weekly");
    expect(classifyKind(byTicker("ETH2611202200"))).toBe("weekly");
    expect(classifyKind(byTicker("BTC2611302200"))).toBe("month-end");
    expect(classifyKind(byTicker("BTC05M2611152020"))).toBe("5-minute");
  });

  it("returns null for non-crypto events", () => {
    expect(classifyKind({ ...byTicker("BTC2611202200"), category: "Sports" })).toBeNull();
  });
});

describe("normalizeEvent", () => {
  it("marks ladders and leaves Up/Down events out", () => {
    expect(normalizeEvent(byTicker("BTC2611202200")).isLadder).toBe(true);
    const upDown = normalizeEvent(byTicker("BTC05M2611152020"));
    expect(upDown.isLadder).toBe(false);
    expect(upDown.contracts[0]?.strike?.type).toBe("reference");
  });

  it("tolerates unknown fields and settled contracts with empty price sides", () => {
    const settled = eventsResponseSchema.parse(fixture("recently-settled-crypto.json")).data[0];
    expect(settled).toBeDefined();
    if (settled === undefined) return;
    const event = normalizeEvent(settled);
    expect(event.contracts[0]?.quote.noBuyCents).toBeNull();
    expect(event.contracts[0]?.resolutionSide).toMatch(/^(yes|no)$/);
  });
});

describe("buildLadder", () => {
  const event = normalizeEvent(eventSchema.parse(fixture("event-BTC2611202200-2026-11-14.json")));
  const spot: SpotPrice = {
    asset: "BTC",
    symbol: "btcusd",
    bidCents: 6_558_600,
    askCents: 6_558_600,
    lastCents: 6_558_600,
    midCents: 6_558_600,
    fetchedAt: "2026-11-14T15:50:00.000Z",
  };
  const ladder = buildLadder(event, spot, { fetchedAt: spot.fetchedAt });

  it("returns rungs sorted by strike with every price in integer cents", () => {
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(ladder).toMatchObject({
      asset: "BTC",
      eventTicker: "BTC2611202200",
      kind: "weekly",
      expiry: "2026-11-20T22:00:00.000Z",
      settlementIndex: "LS-LRRR-XBTUSD",
    });
    const strikes = ladder.rungs.map((r) => r.strikeCents);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    expect(strikes[0]).toBe(6_400_000);
    expect(strikes.at(-1)).toBe(7_100_000);
    expect(ladder.rungs.find((r) => r.strikeCents === 6_400_000)).toEqual({
      strikeCents: 6_400_000,
      instrumentSymbol: "GEMI-BTC2611202200-HI64000",
      label: "$64,000 or above",
      marketState: "open",
      yesBidCents: 66,
      yesAskCents: 71,
      noBuyCents: 34,
      noSellCents: 29,
      lastTradeCents: null,
    });
  });

  it("matches the design-doc NO prices at the four strikes below spot", () => {
    const noBuy = (strike: number) => ladder?.rungs.find((r) => r.strikeCents === strike)?.noBuyCents;
    expect([6_550_000, 6_500_000, 6_450_000, 6_400_000].map(noBuy)).toEqual([48, 43, 38, 34]);
  });

  it("returns null for an event that is not a ladder", () => {
    expect(buildLadder(normalizeEvent(byTicker("BTC05M2611152020")), spot, { fetchedAt: "" })).toBeNull();
  });
});

describe("normalizeBook and normalizeTicker", () => {
  it("sorts book levels and converts sizes to hundredths", () => {
    const book = normalizeBook(
      "GEMI-X",
      orderBookSchema.parse({
        bids: [
          { price: "0.57", amount: "25.0" },
          { price: "0.59", amount: "250.0" },
        ],
        asks: [
          { price: "0.67", amount: "25" },
          { price: "0.63", amount: "250.5" },
        ],
      }),
      "t",
    );
    expect(book.bids).toEqual([
      { priceCents: 59, quantityHundredths: 25_000 },
      { priceCents: 57, quantityHundredths: 2_500 },
    ]);
    expect(book.asks[0]).toEqual({ priceCents: 63, quantityHundredths: 25_050 });
  });

  it("takes the mid of bid and ask, falling back to last", () => {
    const spot = normalizeTicker("BTC", tickerSchema.parse(fixture("pubticker-btcusd.json")), "t");
    expect(spot).toMatchObject({
      symbol: "btcusd",
      bidCents: 6_471_000,
      askCents: 6_471_001,
      midCents: 6_471_001,
    });
    expect(normalizeTicker("BTC", { bid: null, ask: null, last: "10.00" }, "t")?.midCents).toBe(1000);
    expect(normalizeTicker("BTC", { bid: null, ask: null, last: null }, "t")).toBeNull();
  });
});
