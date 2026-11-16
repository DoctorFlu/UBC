/**
 * Gemini market data for the tools: public, read-only endpoints through `@mandate/gemini`. No
 * account key, no authenticated route and no order placement exist on this path.
 */
import {
  createGeminiClient,
  isGeminiError,
  type GeminiClient,
  type GeminiClientOptions,
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

/** Gemini symbols are `GEMI-<event ticker>-<contract ticker>`, and event tickers may contain dashes. */
const SYMBOL = /^GEMI-[A-Za-z0-9._-]+$/;
const MAX_RESOLVE_ATTEMPTS = 4;
/** The longest market the trade tools accept (`tradeArgs.market`). */
const MAX_SYMBOL_LENGTH = 128;

/** Whether a string has the shape of a Gemini instrument symbol, the only markets this server proposes. */
export function isGeminiSymbol(value: string): boolean {
  return value.length <= MAX_SYMBOL_LENGTH && SYMBOL.test(value);
}

/**
 * Candidate event tickers for a symbol, longest first: the contract ticker is the last segment
 * in every listing seen, but trying shorter prefixes keeps this correct if a contract ticker ever
 * contains a dash too.
 */
export function eventTickerCandidates(instrumentSymbol: string): string[] {
  if (!SYMBOL.test(instrumentSymbol)) return [];
  const parts = instrumentSymbol.slice("GEMI-".length).split("-");
  const candidates: string[] = [];
  for (let end = parts.length - 1; end >= 1 && candidates.length < MAX_RESOLVE_ATTEMPTS; end--) {
    candidates.push(parts.slice(0, end).join("-"));
  }
  return candidates;
}

export function createGeminiMarkets(options: GeminiClientOptions = {}): MarketsClient {
  const client: GeminiClient = createGeminiClient({ maxRetries: 1, timeoutMs: 8_000, ...options });
  const resolved = new Map<string, string>();

  return {
    venue: "gemini",
    listEvents: ({ categories, search }) =>
      client.listEvents({
        ...(categories === undefined ? {} : { category: categories }),
        ...(search === undefined ? {} : { search }),
        maxPages: 4,
      }),
    getEvent: (eventTicker) => client.getEvent(eventTicker),
    listLadders: (asset) => client.listLadders(asset),
    getLadder: (opts) => client.getLadder(opts),
    getSpot: (asset) => client.getSpot(asset),
    async resolveMarket(instrumentSymbol) {
      const known = resolved.get(instrumentSymbol);
      const candidates = known === undefined ? eventTickerCandidates(instrumentSymbol) : [known];
      for (const ticker of candidates) {
        let event: MarketEvent;
        try {
          event = await client.getEvent(ticker);
        } catch (error) {
          if (isGeminiError(error, "not_found") || isGeminiError(error, "invalid_argument")) continue;
          throw error;
        }
        const contract = event.contracts.find((c) => c.instrumentSymbol === instrumentSymbol);
        if (contract === undefined) continue;
        resolved.set(instrumentSymbol, ticker);
        return { instrumentSymbol, event, contract, categoryId: categoryFromGemini(event.category ?? "") };
      }
      return null;
    },
  };
}
