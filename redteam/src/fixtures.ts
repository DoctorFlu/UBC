/**
 * Market data for the self-contained run: one Crypto ladder and one Sports event, shaped exactly
 * like `@mandate/gemini` returns them, so the run is deterministic and needs no network. The MCP
 * server resolves categories from this data the same way it does from Gemini. The live-stack run
 * uses real Gemini data instead.
 */
import {
  buildLadder,
  ladderRungs,
  GeminiError,
  type MarketContract,
  type MarketEvent,
  type SpotPrice,
} from "@mandate/gemini";
import type { MarketsClient } from "@mandate/agent";
import { categoryFromGemini } from "@mandate/shared";

const EXPIRY = "2026-11-20T22:00:00.000Z";
const LADDER_TICKER = "BTC2611202200";

function contract(
  symbol: string,
  ticker: string,
  label: string,
  strikeDollars: number | null,
  expiry = EXPIRY,
): MarketContract {
  return {
    instrumentSymbol: symbol,
    ticker,
    label,
    status: "active",
    marketState: "open",
    expiry,
    strike:
      strikeDollars === null
        ? null
        : { type: "above", value: String(strikeDollars), valueCents: strikeDollars * 100 },
    quote: {
      yesBuyCents: 62,
      yesSellCents: 60,
      noBuyCents: 40,
      noSellCents: 38,
      yesBidCents: 60,
      yesAskCents: 62,
      lastTradeCents: null,
    },
    resolutionSide: null,
    resolvedAt: null,
    settlementValue: null,
    quantityIncrement: null,
    quantityMinimum: null,
    priceIncrement: null,
  };
}

export const CRYPTO_SYMBOL = `GEMI-${LADDER_TICKER}-HI64000`;
/**
 * A second BTC ladder, the next week's, that only `mcp.repeat-and-overlap-runs` plans on, so the
 * orders other attacks leave on the first ladder do not count as protection there.
 */
export const HEDGE_LADDER_TICKER = "BTC2611272200";
const HEDGE_EXPIRY = "2026-11-27T22:00:00.000Z";
/** BTC spot for planning: between the second ladder's $64,000 and $64,500 strikes. */
export const SPOT_CENTS = 6_420_000;
const SPOT: SpotPrice = {
  asset: "BTC",
  symbol: "btcusd",
  bidCents: SPOT_CENTS,
  askCents: SPOT_CENTS,
  lastCents: SPOT_CENTS,
  midCents: SPOT_CENTS,
  fetchedAt: "2026-11-16T12:00:00.000Z",
};
export const SPORTS_SYMBOL = "GEMI-NFL-2611152125-SF-DAL-M-SF";

const EVENTS: MarketEvent[] = [
  {
    id: "1",
    ticker: LADDER_TICKER,
    title: "BTC price on November 20",
    category: "Crypto",
    type: "categorical",
    status: "active",
    expiry: EXPIRY,
    asset: "BTC",
    kind: "weekly",
    isLadder: true,
    settlementIndex: "LS-LRRR-XBTUSD",
    volumeCents: 1_000_000,
    contracts: [62_000, 63_000, 64_000, 65_000].map((k) =>
      contract(`GEMI-${LADDER_TICKER}-HI${k}`, `HI${k}`, `$${k} or above`, k),
    ),
  },
  {
    id: "3",
    ticker: HEDGE_LADDER_TICKER,
    title: "BTC price on November 27",
    category: "Crypto",
    type: "categorical",
    status: "active",
    expiry: HEDGE_EXPIRY,
    asset: "BTC",
    kind: "weekly",
    isLadder: true,
    settlementIndex: "LS-LRRR-XBTUSD",
    volumeCents: 1_000_000,
    contracts: [62_500, 63_000, 63_500, 64_000, 64_500, 65_000].map((k) =>
      contract(`GEMI-${HEDGE_LADDER_TICKER}-HI${k}`, `HI${k}`, `$${k} or above`, k, HEDGE_EXPIRY),
    ),
  },
  {
    id: "2",
    ticker: "NFL-2611152125-SF-DAL-M",
    title: "San Francisco vs Dallas",
    category: "Sports",
    type: "binary",
    status: "active",
    expiry: EXPIRY,
    asset: null,
    kind: null,
    isLadder: false,
    settlementIndex: null,
    volumeCents: 5_000_000,
    contracts: [contract(SPORTS_SYMBOL, "SF", "San Francisco", null)],
  },
];

function notUsed(name: string): never {
  throw new GeminiError("invalid_argument", `${name} is not part of the red team's market fixture`);
}

/**
 * A markets client over the fixture events. Ladders are served by event ticker (a horizon gets the
 * first ladder of the asset), at a fixed spot and without order book depth.
 */
export function fixtureMarkets(): MarketsClient {
  return {
    venue: "gemini",
    listEvents: ({ categories }) =>
      Promise.resolve(
        EVENTS.filter((e) => categories === undefined || categories.includes(e.category ?? "")).map((e) => ({
          id: e.id,
          ticker: e.ticker,
          title: e.title,
          category: e.category,
          type: e.type,
          status: e.status,
          expiry: e.expiry,
          asset: e.asset,
          kind: e.kind,
          isLadder: e.isLadder,
          contractCount: e.contracts.length,
          volumeCents: e.volumeCents,
        })),
      ),
    getEvent: (ticker) => {
      const event = EVENTS.find((e) => e.ticker === ticker);
      return event === undefined
        ? Promise.reject(new GeminiError("not_found", `no event ${ticker}`))
        : Promise.resolve(event);
    },
    listLadders: () => notUsed("listLadders"),
    getLadder: (options) => {
      const event = EVENTS.find((e) =>
        options.eventTicker !== undefined
          ? e.ticker === options.eventTicker
          : e.isLadder && e.asset === options.asset.toUpperCase(),
      );
      const ladder = event === undefined ? null : buildLadder(event, SPOT, { fetchedAt: SPOT.fetchedAt });
      return ladder === null
        ? Promise.reject(new GeminiError("not_found", "no such ladder in the red team's market fixture"))
        : Promise.resolve(ladder);
    },
    getSpot: (asset) => (asset.toUpperCase() === "BTC" ? Promise.resolve(SPOT) : notUsed(`getSpot ${asset}`)),
    // One exchange here: production lists what the fixture lists.
    productionStrikes: (ticker) => {
      const event = EVENTS.find((e) => e.ticker === ticker);
      return event === undefined
        ? Promise.reject(new GeminiError("not_found", `no event ${ticker}`))
        : Promise.resolve(new Map(ladderRungs(event).map((r) => [r.instrumentSymbol, r.strikeCents])));
    },
    resolveMarket: (instrumentSymbol) => {
      for (const event of EVENTS) {
        const found = event.contracts.find((c) => c.instrumentSymbol === instrumentSymbol);
        if (found !== undefined) {
          return Promise.resolve({
            instrumentSymbol,
            event,
            contract: found,
            categoryId: categoryFromGemini(event.category ?? ""),
          });
        }
      }
      return Promise.resolve(null);
    },
  };
}
