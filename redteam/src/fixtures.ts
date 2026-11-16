/**
 * Market data for the self-contained run: one Crypto ladder and one Sports event, shaped exactly
 * like `@mandate/gemini` returns them, so the run is deterministic and needs no network. The MCP
 * server resolves categories from this data the same way it does from Gemini. The live-stack run
 * uses real Gemini data instead.
 */
import { GeminiError, type MarketContract, type MarketEvent } from "@mandate/gemini";
import type { MarketsClient } from "@mandate/agent";
import { categoryFromGemini } from "@mandate/shared";

const EXPIRY = "2026-11-20T22:00:00.000Z";
const LADDER_TICKER = "BTC2611202200";

function contract(
  symbol: string,
  ticker: string,
  label: string,
  strikeDollars: number | null,
): MarketContract {
  return {
    instrumentSymbol: symbol,
    ticker,
    label,
    status: "active",
    marketState: "open",
    expiry: EXPIRY,
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
    settlementValue: null,
  };
}

export const CRYPTO_SYMBOL = `GEMI-${LADDER_TICKER}-HI64000`;
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

/** A markets client over the two fixture events. Only lookups are supported; ladders and spot are not. */
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
    getLadder: () => notUsed("getLadder"),
    getSpot: () => notUsed("getSpot"),
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
