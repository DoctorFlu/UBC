/**
 * Turns a signal query into a finished signal document, or into a refusal the seller can give for
 * free. The paid handler never calls this: it runs before the payment middleware, so a buyer is only
 * asked to pay once the signal is already computed.
 */
import { isGeminiError, type Candle, type GetLadderOptions, type Ladder } from "@mandate/gemini";
import type { HedgeSignal, HedgeSignalQuery, SignalErrorCode } from "@mandate/shared";
import { buildHedgeSignal, type SignalModelConfig } from "./build";

/** The market data the signal needs. `GeminiClient` from `@mandate/gemini` satisfies it. */
export interface HedgeSignalSource {
  getLadder(options: GetLadderOptions): Promise<Ladder>;
  getCandles(asset: string, timeFrame: "1hr"): Promise<Candle[]>;
}

export type PrepareResult =
  | { ok: true; signal: HedgeSignal }
  | { ok: false; status: 400 | 404 | 422 | 503; code: SignalErrorCode; message: string };

export interface HedgeSignalService {
  /** Assets this seller covers, upper case. */
  readonly assets: readonly string[];
  readonly model: SignalModelConfig;
  prepare(query: HedgeSignalQuery): Promise<PrepareResult>;
}

const STATUS: Record<SignalErrorCode, 400 | 404 | 422 | 503> = {
  invalid_query: 400,
  unknown_asset: 404,
  no_ladder: 404,
  expired: 422,
  insufficient_history: 503,
  market_data_unavailable: 503,
};

export function refusal(code: SignalErrorCode, message: string): Extract<PrepareResult, { ok: false }> {
  return { ok: false, status: STATUS[code], code, message };
}

export function createHedgeSignalService(options: {
  source: HedgeSignalSource;
  assets: readonly string[];
  model: SignalModelConfig;
  now?: () => number;
}): HedgeSignalService {
  const now = options.now ?? (() => Date.now());
  const assets = options.assets.map((asset) => asset.toUpperCase());

  async function prepare(query: HedgeSignalQuery): Promise<PrepareResult> {
    if (!assets.includes(query.asset)) {
      return refusal("unknown_asset", `This seller covers ${assets.join(", ")}, not ${query.asset}.`);
    }
    const selection: GetLadderOptions =
      query.eventTicker !== undefined
        ? { asset: query.asset, eventTicker: query.eventTicker }
        : query.expiry !== undefined
          ? { asset: query.asset, expiry: query.expiry }
          : { asset: query.asset, ...(query.horizon === undefined ? {} : { horizon: query.horizon }) };

    let ladder: Ladder;
    let candles: Candle[];
    try {
      [ladder, candles] = await Promise.all([
        options.source.getLadder(selection),
        options.source.getCandles(query.asset, "1hr"),
      ]);
    } catch (error) {
      if (isGeminiError(error, "no_ladder") || isGeminiError(error, "not_found")) {
        return refusal("no_ladder", noLadderMessage(error.message, query));
      }
      if (isGeminiError(error, "invalid_argument")) return refusal("invalid_query", error.message);
      return refusal(
        "market_data_unavailable",
        "Gemini market data could not be loaded right now; nothing was charged. Try again in a minute.",
      );
    }

    const built = buildHedgeSignal({ ladder, candles, nowMs: now(), config: options.model });
    return built.ok ? { ok: true, signal: built.signal } : refusal(built.code, built.message);
  }

  return { assets, model: options.model, prepare };
}

function noLadderMessage(message: string, query: HedgeSignalQuery): string {
  // The client's no_ladder message lists the open ladders, which helps the buyer pick another one.
  return message.startsWith("No open") || message.startsWith("Event ")
    ? message
    : `No open ${query.asset} ladder matches ${query.eventTicker ?? query.expiry ?? query.horizon ?? "the query"}.`;
}
