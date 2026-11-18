/**
 * Gemini market data for the tools: public, read-only endpoints through `@mandate/gemini`. No
 * account key, no authenticated route and no order placement exist on this path.
 */
import {
  createMarketDataClient,
  createProductionClient,
  eventTickerCandidates,
  findInstrument,
  GEMINI_HOSTS,
  isInstrumentSymbol,
  ladderRungs,
  type GeminiClient,
  type MarketDataClientOptions,
  type MarketDataSource,
  type MarketContract,
  type MarketEvent,
} from "@mandate/gemini";
import { categoryFromGemini, type CategoryId } from "@mandate/shared";
import type { MarketsClient } from "../services";

export interface ResolvedMarket {
  instrumentSymbol: string;
  event: MarketEvent;
  contract: MarketContract;
  /** The mandate's category id, from Gemini's category of the event. Never taken from the agent. */
  categoryId: CategoryId;
}

/** Whether a string has the shape of a Gemini instrument symbol, the only markets this server proposes. */
export const isGeminiSymbol = isInstrumentSymbol;
export { eventTickerCandidates };

const PRODUCTION: Pick<MarketDataSource, "baseUrl" | "productionBaseUrl"> = {
  baseUrl: GEMINI_HOSTS.production,
  productionBaseUrl: GEMINI_HOSTS.production,
};

/**
 * Market data from the stack's source (`marketDataSource`, production by default): listings and books from
 * the venue's exchange, spot from production's (`createMarketDataClient`).
 */
export function createGeminiMarkets(
  source: Pick<MarketDataSource, "baseUrl" | "productionBaseUrl"> = PRODUCTION,
  options: MarketDataClientOptions = {},
): MarketsClient {
  const settings = { maxRetries: 1, timeoutMs: 8_000, ...options };
  const client: GeminiClient = createMarketDataClient(source, settings);
  // The same client when the venue is production: nothing is read twice.
  const production: GeminiClient =
    source.productionBaseUrl === source.baseUrl ? client : createProductionClient(source, settings);
  const resolved = new Map<string, string>();

  return {
    venue: "gemini",
    listEvents: ({ categories, search }, signal) =>
      client.listEvents(
        {
          ...(categories === undefined ? {} : { category: categories }),
          ...(search === undefined ? {} : { search }),
          maxPages: 4,
        },
        { signal },
      ),
    getEvent: (eventTicker, signal) => client.getEvent(eventTicker, { signal }),
    listLadders: (asset, signal) => client.listLadders(asset, { signal }),
    getLadder: (opts, signal) => client.getLadder(opts, { signal }),
    getSpot: (asset, signal) => client.getSpot(asset, { signal }),
    async productionStrikes(eventTicker, signal) {
      const event = await production.getEvent(eventTicker, { signal });
      return new Map(ladderRungs(event).map((rung) => [rung.instrumentSymbol, rung.strikeCents]));
    },
    async resolveMarket(instrumentSymbol, signal) {
      const known = resolved.get(instrumentSymbol);
      const found = await findInstrument(
        (ticker) => client.getEvent(ticker, { signal }),
        instrumentSymbol,
        known === undefined ? eventTickerCandidates(instrumentSymbol) : [known],
      );
      if (found === null) return null;
      resolved.set(instrumentSymbol, found.eventTicker);
      const { event, contract } = found;
      return { instrumentSymbol, event, contract, categoryId: categoryFromGemini(event.category ?? "") };
    },
  };
}
