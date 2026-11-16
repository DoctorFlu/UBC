/**
 * The SIMULATED executor, for development only: it never places an order. It is still the last offchain
 * step before an order would exist, so it refuses anything the venue could not trade, the way a real
 * executor must. The contract stores any market, outcome and limit price the agent key sends, and trusts
 * the category it is given; only the amount rules are enforced onchain.
 *
 * For each approved intent it reads the stored intent (authoritative, and the only place the category is),
 * then:
 * - refuses it and records it as not filled when the market is not a Gemini symbol, the outcome is not YES
 *   or NO, the limit price is outside 1 to 99, a number does not fit, Gemini does not list the market, or
 *   Gemini lists it under another category than the intent's;
 * - when Gemini cannot be reached, does nothing and tries again later: an order that cannot be checked is
 *   never filled, and a venue outage is not the intent's fault, so it is not failed either;
 * - otherwise records a full fill at zero profit and loss after a short delay.
 */
import { findInstrument, isInstrumentSymbol, type GeminiClient } from "@mandate/gemini";
import {
  categoryFromGemini,
  categoryLabel,
  formatCents,
  isValidLimitPrice,
  type CategoryId,
  type Intent,
  type PolicyClient,
} from "@mandate/shared";

/** What the executor needs from the venue. Injectable, so tests and the red team need no network. */
export interface Venue {
  /**
   * The mandate category of the event that lists `instrumentSymbol`, or null when the venue lists no such
   * instrument. Throws when the venue cannot be reached or answers with anything else.
   */
  categoryOf(instrumentSymbol: string): Promise<CategoryId | null>;
}

/** The venue backed by Gemini's public market data. */
export function geminiVenue(client: Pick<GeminiClient, "getEvent">): Venue {
  return {
    async categoryOf(instrumentSymbol) {
      const found = await findInstrument((ticker) => client.getEvent(ticker), instrumentSymbol);
      return found === null ? null : categoryFromGemini(found.event.category ?? "");
    },
  };
}

export type RefusalCode =
  | "market_not_a_symbol"
  | "outcome_not_yes_no"
  | "limit_price_out_of_range"
  | "number_out_of_range"
  | "market_not_listed"
  | "category_mismatch";

/** On success, the amount and limit price the order would use, both known to fit. */
export type IntentCheck =
  { ok: true; amountCents: number; limitPrice: number } | { ok: false; code: RefusalCode; detail: string };

/** A market string safe to print: the symbol, or a description of what was there instead. */
export function describeMarket(market: string): string {
  return isInstrumentSymbol(market)
    ? market
    : `a ${Array.from(market).length}-character market that is not a Gemini symbol`;
}

/**
 * Whether the executor may act on an approved intent. The checks that need no network run first, so a
 * malformed intent is refused even while the venue is down. Throws only when the venue cannot be reached.
 */
export async function checkApprovedIntent(intent: Intent, venue: Venue): Promise<IntentCheck> {
  if (!isInstrumentSymbol(intent.market)) {
    return { ok: false, code: "market_not_a_symbol", detail: describeMarket(intent.market) };
  }
  if (intent.outcome !== "YES" && intent.outcome !== "NO") {
    return { ok: false, code: "outcome_not_yes_no", detail: "the outcome is not YES or NO" };
  }
  const { amountCents, limitPrice } = intent;
  if (amountCents === null || limitPrice === null) {
    const fields = Object.entries(intent.outOfRange ?? {}).map(([field, raw]) => `${field} ${raw}`);
    return {
      ok: false,
      code: "number_out_of_range",
      detail: `${fields.join(", ") || "a number"} does not fit an amount or price offchain code can use`,
    };
  }
  if (amountCents <= 0) {
    return { ok: false, code: "number_out_of_range", detail: "the amount is zero" };
  }
  if (!isValidLimitPrice(limitPrice)) {
    return {
      ok: false,
      code: "limit_price_out_of_range",
      detail: `limit price ${String(limitPrice)} is outside 1 to 99 cents`,
    };
  }
  const listed = await venue.categoryOf(intent.market);
  if (listed === null) {
    return { ok: false, code: "market_not_listed", detail: `Gemini does not list ${intent.market}` };
  }
  if (listed !== intent.category) {
    return {
      ok: false,
      code: "category_mismatch",
      detail: `Gemini lists ${intent.market} as ${categoryLabel(listed)}, the intent says ${categoryLabel(intent.category)}`,
    };
  }
  return { ok: true, amountCents, limitPrice };
}

export interface SimulatedExecutorOptions {
  /** A client signing as the contract's executor. */
  client: PolicyClient;
  venue: Venue;
  /** First block to read approvals from (the deployment block, to catch up after a restart). */
  fromBlock?: bigint;
  /** Delay before a fill, so the console shows the approved state first. */
  fillDelayMs?: number;
  /** How long to wait before checking again when the venue could not be reached. */
  venueRetryMs?: number;
  pollingIntervalMs?: number;
  log?: (line: string) => void;
}

export interface SimulatedExecutor {
  stop: () => void;
}

/** Watches for approvals and handles each one; a failure on one intent never stops the others. */
export function startSimulatedExecutor(options: SimulatedExecutorOptions): SimulatedExecutor {
  const { client, venue } = options;
  const fillDelayMs = options.fillDelayMs ?? 1_500;
  const venueRetryMs = options.venueRetryMs ?? 15_000;
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const inFlight = new Set<number>();
  const retries = new Map<number, ReturnType<typeof setTimeout>>();
  let stopped = false;
  // Read through a function so the compiler does not narrow `stopped` across awaits.
  const isStopped = (): boolean => stopped;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function handle(intentId: number): Promise<void> {
    if (isStopped() || inFlight.has(intentId)) return;
    inFlight.add(intentId);
    try {
      const intent = await client.getIntent(intentId);
      if (intent?.status !== "approved") return; // already recorded, for example after a restart

      let check: IntentCheck;
      try {
        check = await checkApprovedIntent(intent, venue);
      } catch (error) {
        log(
          `[sim-executor] intent #${intentId}: could not check the market on Gemini (${errorText(error)}); ` +
            `not filling it, trying again in ${Math.round(venueRetryMs / 1000)} s`,
        );
        if (!isStopped() && !retries.has(intentId)) {
          retries.set(
            intentId,
            setTimeout(() => {
              retries.delete(intentId);
              void handle(intentId);
            }, venueRetryMs),
          );
        }
        return;
      }

      if (!check.ok) {
        const { txHash } = await client.recordResult({
          intentId,
          filled: false,
          filledCents: 0,
          pnlCents: 0,
        });
        log(
          `[sim-executor] intent #${intentId} REFUSED (${check.code}): ${check.detail}; recorded as not filled (${txHash})`,
        );
        return;
      }

      await wait(fillDelayMs);
      if (isStopped()) return;
      const { txHash } = await client.recordResult({
        intentId,
        filled: true,
        filledCents: check.amountCents,
        pnlCents: 0,
      });
      log(
        `[sim-executor] intent #${intentId} ${intent.isBuy ? "buy" : "sell"} ${intent.outcome} ${intent.market} ` +
          `${formatCents(check.amountCents)} at ${check.limitPrice}c: simulated full fill (${txHash})`,
      );
    } catch (error) {
      log(`[sim-executor] intent #${intentId}: ${errorText(error)}`);
    } finally {
      inFlight.delete(intentId);
    }
  }

  const stopWatching = client.watchEvents({
    ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
    ...(options.pollingIntervalMs === undefined ? {} : { pollingIntervalMs: options.pollingIntervalMs }),
    onEvents: (events) => {
      for (const event of events) {
        if (event.type === "IntentApproved") void handle(event.intentId);
      }
    },
    onError: (error) => {
      log(`[sim-executor] polling failed: ${errorText(error)}`);
    },
  });

  return {
    stop() {
      stopped = true;
      stopWatching();
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
    },
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
