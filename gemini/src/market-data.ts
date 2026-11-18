/**
 * The one way a service builds its Gemini market-data clients from the stack's `MarketDataSource`, so no
 * service can read spot from one exchange and books from another by accident (18 November 2026: the
 * sandbox's BTC spot was about $700 below the index its ladders settle on).
 *
 * - `createMarketDataClient`: listings, events and books from the venue's exchange; spot and candles from
 *   production, the exchange whose index every ladder settles on. If production's spot cannot be read the
 *   call fails: it never falls back to the venue's own ticker.
 * - `createProductionClient`: production's public API alone, for fills the simulated venue made, which are
 *   listed and resolved on production whatever the stack trades on now.
 */
import { createGeminiClient, type GeminiClient, type GeminiClientOptions } from "./client";
import type { MarketDataSource } from "./environment";

export type MarketDataClientOptions = Omit<GeminiClientOptions, "baseUrl" | "spotBaseUrl">;

export function createMarketDataClient(
  source: Pick<MarketDataSource, "baseUrl" | "productionBaseUrl">,
  options: MarketDataClientOptions = {},
): GeminiClient {
  return createGeminiClient({ ...options, baseUrl: source.baseUrl, spotBaseUrl: source.productionBaseUrl });
}

export function createProductionClient(
  source: Pick<MarketDataSource, "productionBaseUrl">,
  options: MarketDataClientOptions = {},
): GeminiClient {
  return createGeminiClient({ ...options, baseUrl: source.productionBaseUrl });
}

/**
 * What the owner and the agent are told a ladder's spot is, wherever it is shown: for example "Gemini's
 * live BTC/USD price, from the exchange whose index the ladder settles on", or, when the spread was too
 * wide for a mid (`SpotPrice.basis`), that it is the last trade.
 */
export function spotSourceText(asset: string, basis: "mid" | "last" = "mid"): string {
  const pair = `${asset.toUpperCase()}/USD`;
  return basis === "last"
    ? `the last trade on Gemini's live ${pair} market, whose spread was too wide for a mid; the ladder settles on that exchange's index`
    : `Gemini's live ${pair} price, from the exchange whose index the ladder settles on`;
}
