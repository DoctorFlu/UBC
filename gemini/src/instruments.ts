/**
 * Gemini instrument symbols: `GEMI-<event ticker>-<contract ticker>`, where event tickers may contain
 * dashes. One definition for every package that must tell a real symbol from arbitrary text, such as a
 * market string read from the chain.
 */
import { isMarketSymbol, MAX_MARKET_SYMBOL_LENGTH } from "@mandate/shared";
import { isGeminiError } from "./errors";
import type { MarketContract, MarketEvent } from "./types";

/** The shape rule lives in `@mandate/shared`, next to the readers that flag onchain text. */
export const MAX_INSTRUMENT_SYMBOL_LENGTH = MAX_MARKET_SYMBOL_LENGTH;
export const isInstrumentSymbol = isMarketSymbol;

/** The most event tickers tried for one symbol, so the most `getEvent` calls one lookup can make. */
export const MAX_RESOLVE_ATTEMPTS = 4;

/**
 * Candidate event tickers for a symbol, longest first: the contract ticker is the last segment in every
 * listing seen, but trying shorter prefixes keeps this correct if a contract ticker ever contains a dash.
 */
export function eventTickerCandidates(instrumentSymbol: string): string[] {
  if (!isInstrumentSymbol(instrumentSymbol)) return [];
  const parts = instrumentSymbol.slice("GEMI-".length).split("-");
  const candidates: string[] = [];
  for (let end = parts.length - 1; end >= 1 && candidates.length < MAX_RESOLVE_ATTEMPTS; end--) {
    candidates.push(parts.slice(0, end).join("-"));
  }
  return candidates;
}

export interface FoundInstrument {
  eventTicker: string;
  event: MarketEvent;
  contract: MarketContract;
}

/**
 * The event that lists `instrumentSymbol`, or null when Gemini lists it nowhere (including when it is not
 * a symbol at all). Any other failure, such as Gemini being unreachable, is thrown: "not listed" and "could
 * not check" must never be confused.
 */
export async function findInstrument(
  getEvent: (eventTicker: string) => Promise<MarketEvent>,
  instrumentSymbol: string,
  candidates: readonly string[] = eventTickerCandidates(instrumentSymbol),
): Promise<FoundInstrument | null> {
  for (const eventTicker of candidates) {
    let event: MarketEvent;
    try {
      event = await getEvent(eventTicker);
    } catch (error) {
      if (isGeminiError(error, "not_found") || isGeminiError(error, "invalid_argument")) continue;
      throw error;
    }
    const contract = event.contracts.find((c) => c.instrumentSymbol === instrumentSymbol);
    if (contract !== undefined) return { eventTicker, event, contract };
  }
  return null;
}
