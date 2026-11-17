/**
 * The executor: the last offchain step before an order exists, and the one that records what happened.
 * Every venue goes through the seam in `venue.ts`; today the only one is the SIMULATED venue, which never
 * places an order. The contract stores any market, outcome and limit price the agent key sends, and
 * trusts the category it is given; only the amount rules are enforced onchain, so the executor refuses
 * anything the venue could not trade, the way a real executor must.
 *
 * For each approved intent it reads the stored intent (authoritative, and the only place the category is),
 * then:
 * - refuses it and records it as not filled when the market is not a Gemini symbol, the outcome is not YES
 *   or NO, the limit price is outside 1 to 99, a number does not fit, Gemini does not list the market, or
 *   Gemini lists it under another category than the intent's;
 * - when the venue cannot be reached, does nothing and tries again later: an order that cannot be checked
 *   is never placed, and a venue outage is not the intent's fault, so it is not failed either;
 * - otherwise places the order, follows it until it is closed, and records the fill with `recordResult`.
 *
 * Settlement (issue #92): every filled buy is checked again once its market has expired. When the venue
 * has published the outcome, the executor records what the position paid. The contract cannot hold that
 * (`recordResult` takes one call per intent, and the fill used it), so the record goes to the console,
 * signed with the executor key. It is recorded at most once per intent, across restarts (the console keeps
 * the first record), and never before the outcome is published.
 */
import { eventTickerCandidates, isInstrumentSymbol } from "@mandate/gemini";
import {
  categoryLabel,
  formatCents,
  hashSettlement,
  isValidLimitPrice,
  settlementMessage,
  type Intent,
  type PolicyClient,
  type Settlement,
} from "@mandate/shared";
import type { SettlementSink } from "./settlement-sink";
import type { HeldPosition, PositionOutcome, Venue } from "./venue";

export type RefusalCode =
  | "market_not_a_symbol"
  | "outcome_not_yes_no"
  | "limit_price_out_of_range"
  | "number_out_of_range"
  | "market_not_listed"
  | "category_mismatch";

/** On success, the amount and limit price the order would use, both known to fit. */
export type IntentCheck =
  | { ok: true; outcome: "YES" | "NO"; amountCents: number; limitPrice: number }
  | { ok: false; code: RefusalCode; detail: string };

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
export async function checkApprovedIntent(
  intent: Intent,
  venue: Pick<Venue, "categoryOf">,
): Promise<IntentCheck> {
  if (!isInstrumentSymbol(intent.market)) {
    return { ok: false, code: "market_not_a_symbol", detail: describeMarket(intent.market) };
  }
  const outcome = intent.outcome;
  if (outcome !== "YES" && outcome !== "NO") {
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
  return { ok: true, outcome, amountCents, limitPrice };
}

export interface ExecutorOptions {
  /** A client signing as the contract's executor. Its key also signs settlements. */
  client: PolicyClient;
  venue: Venue;
  /** Where settlements are recorded. Without one, positions are filled and never settled. */
  settlements?: SettlementSink;
  /** First block to read from (the deployment block, to catch up after a restart). */
  fromBlock?: bigint;
  /** Delay before placing an order, so the console shows the approved state first. */
  fillDelayMs?: number;
  /** How often an open order is checked again. */
  fillPollMs?: number;
  /** How long to wait before checking again when the venue could not be reached. */
  venueRetryMs?: number;
  /**
   * How often the settlement timer looks for a position that is due. A look is local: the venue and the
   * console are asked only about a position whose market has expired (or whose wait below has ended).
   */
  settleIntervalMs?: number;
  /**
   * Waits between two questions about a ladder that has expired without an outcome yet, or a settlement
   * the console did not take: the first wait, then the next, the last one repeating. Default 1, 2, 5, 10,
   * then every 30 minutes.
   */
  settleBackoffMs?: readonly number[];
  /**
   * Off by default: a position on a market that still trades is asked about again only at its expiry, so
   * an idle machine makes no call. Set, it is also asked after this long, for a venue that may move an
   * expiry (the end-to-end tests move the fake Gemini's).
   */
  openRecheckMs?: number;
  pollingIntervalMs?: number;
  /** Clock in milliseconds, for settlement schedules. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface Executor {
  stop: () => void;
  /** Runs one settlement pass now and resolves when it is done; for tests and the start-up pass. */
  settleNow: () => Promise<void>;
}

/** Gemini publishes an outcome seconds after expiry; the first check after expiry waits this long. */
const SETTLE_GRACE_MS = 5_000;

const MINUTE_MS = 60_000;

/**
 * Waits while an expired ladder has no outcome yet: Gemini usually publishes within seconds, so the first
 * questions come quickly, then they thin out. About 8 requests per ladder in its first two hours, against
 * Gemini's public limit of 120 a minute.
 */
export const SETTLE_BACKOFF_MS: readonly number[] = [
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  30 * MINUTE_MS,
];

/** The ladder a position is on: positions on one ladder expire and are resolved together. */
function ladderOf(market: string): string {
  return eventTickerCandidates(market)[0] ?? market;
}

/**
 * Watches for approvals and fills, handles each approval, and settles filled positions once their
 * market has resolved. A failure on one intent never stops the others.
 */
export function startExecutor(options: ExecutorOptions): Executor {
  const { client, venue } = options;
  const fillDelayMs = options.fillDelayMs ?? 1_500;
  const fillPollMs = options.fillPollMs ?? 5_000;
  const venueRetryMs = options.venueRetryMs ?? 15_000;
  const settleIntervalMs = options.settleIntervalMs ?? 60_000;
  const settleBackoffMs = options.settleBackoffMs?.length ? options.settleBackoffMs : SETTLE_BACKOFF_MS;
  const openRecheckMs = options.openRecheckMs;
  const clock = options.now ?? Date.now;
  const tag = `[${venue.kind}-executor]`;
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

  function retryLater(intentId: number): void {
    if (isStopped() || retries.has(intentId)) return;
    retries.set(
      intentId,
      setTimeout(() => {
        retries.delete(intentId);
        void handle(intentId);
      }, venueRetryMs),
    );
  }

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
          `${tag} intent #${intentId}: could not check the market on Gemini (${errorText(error)}); ` +
            `not placing it, trying again in ${Math.round(venueRetryMs / 1000)} s`,
        );
        retryLater(intentId);
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
          `${tag} intent #${intentId} REFUSED (${check.code}): ${check.detail}; recorded as not filled (${txHash})`,
        );
        return;
      }

      await wait(fillDelayMs);
      if (isStopped()) return;
      const order = {
        intentId,
        market: intent.market,
        outcome: check.outcome,
        isBuy: intent.isBuy,
        amountCents: check.amountCents,
        limitPrice: check.limitPrice,
      };
      let fill;
      try {
        const placed = await venue.placeOrder(order);
        fill = await venue.readFill(placed);
        while (fill.state === "open") {
          await wait(fillPollMs);
          if (isStopped()) return;
          fill = await venue.readFill(placed);
        }
      } catch (error) {
        log(
          `${tag} intent #${intentId}: the venue did not answer (${errorText(error)}); ` +
            `trying again in ${Math.round(venueRetryMs / 1000)} s`,
        );
        retryLater(intentId);
        return;
      }
      const filledCents = Math.min(fill.filledCents, check.amountCents);
      const { txHash } = await client.recordResult({
        intentId,
        filled: filledCents > 0,
        filledCents,
        pnlCents: 0,
      });
      log(
        `${tag} intent #${intentId} ${intent.isBuy ? "buy" : "sell"} ${check.outcome} ${intent.market} ` +
          `${formatCents(check.amountCents)} at ${check.limitPrice}c: ${fill.detail}, ` +
          `${formatCents(filledCents)} filled (${txHash})`,
      );
    } catch (error) {
      log(`${tag} intent #${intentId}: ${errorText(error)}`);
    } finally {
      inFlight.delete(intentId);
    }
  }

  // ---------------------------------------------------------------- settlement

  /**
   * Filled intents not settled yet: when to ask about each again (unix ms), and how many waits of
   * `settleBackoffMs` in a row it has had.
   */
  const filled = new Map<number, { notBefore: number; waits: number }>();
  /** Settled, or never to be settled (a sell, a zero fill): done for good in this process. */
  const done = new Set<number>();
  /** Executed intents never change onchain again, so each is read once. */
  const positions = new Map<number, HeldPosition | null>();
  /** The last thing said about each intent, so a long wait is logged once, not every pass. */
  const notes = new Map<number, string>();
  let settling: Promise<void> | null = null;

  function note(intentId: number, line: string): void {
    if (notes.get(intentId) === line) return;
    notes.set(intentId, line);
    log(`${tag} intent #${intentId}: ${line}`);
  }

  async function position(intentId: number): Promise<HeldPosition | null> {
    const known = positions.get(intentId);
    if (known !== undefined) return known;
    const intent = await client.getIntent(intentId);
    if (intent?.status !== "executed") return null; // not mined into this view yet: ask again next pass
    const { market, outcome, filledCents, limitPrice } = intent;
    let held: HeldPosition | null = null;
    if (
      intent.isBuy &&
      isInstrumentSymbol(market) &&
      (outcome === "YES" || outcome === "NO") &&
      filledCents !== null &&
      filledCents > 0 &&
      limitPrice !== null &&
      isValidLimitPrice(limitPrice)
    ) {
      held = { intentId, market, outcome, costCents: filledCents, limitPrice };
    }
    positions.set(intentId, held);
    return held;
  }

  /** Asks again after the next wait of `settleBackoffMs`. */
  function backOff(intentId: number): void {
    const waits = filled.get(intentId)?.waits ?? 0;
    const delay = settleBackoffMs[Math.min(waits, settleBackoffMs.length - 1)] ?? MINUTE_MS;
    filled.set(intentId, { notBefore: clock() + delay, waits: waits + 1 });
  }

  /** Asks again at the market's expiry (or sooner with `openRecheckMs`), and nothing before. */
  function untilExpiry(intentId: number, expiresAt: string): void {
    const at = Date.parse(expiresAt) + SETTLE_GRACE_MS;
    if (!Number.isFinite(at)) {
      backOff(intentId);
      return;
    }
    const notBefore = openRecheckMs === undefined ? at : Math.min(at, clock() + openRecheckMs);
    filled.set(intentId, { notBefore, waits: 0 });
  }

  /**
   * `ladders` holds what this pass learned about each ladder while it trades or waits for its outcome:
   * that answer holds for every position on it, so a ladder costs one question per pass, not one per
   * position.
   */
  async function settleOne(
    sink: SettlementSink,
    intentId: number,
    ladders: Map<string, PositionOutcome>,
  ): Promise<void> {
    const held = await position(intentId);
    if (held === null) {
      if (positions.has(intentId)) {
        done.add(intentId);
        filled.delete(intentId);
        note(intentId, "nothing to settle: not a filled buy of YES or NO");
      }
      return;
    }
    const ladder = ladderOf(held.market);
    const outcome = ladders.get(ladder) ?? (await venue.positionOutcome(held));
    switch (outcome.status) {
      case "open":
        ladders.set(ladder, outcome);
        untilExpiry(intentId, outcome.expiresAt);
        return;
      case "awaiting":
        ladders.set(ladder, outcome);
        note(intentId, `${held.market} has expired; waiting for Gemini to publish its outcome`);
        backOff(intentId);
        return;
      case "unlisted":
        note(intentId, `Gemini no longer lists ${held.market}; asking again later, never guessing`);
        backOff(intentId);
        return;
      case "resolved":
        break;
    }
    const wallet = client.walletClient;
    if (wallet === undefined) throw new Error("the executor client has no key to sign settlements with");
    const document: Settlement = {
      version: 1,
      chainId: client.publicClient.chain.id,
      policy: client.address.toLowerCase() as `0x${string}`,
      intentId,
      market: held.market,
      eventTicker: outcome.eventTicker,
      strikeCents: outcome.strikeCents,
      expiresAt: outcome.expiresAt,
      outcome: held.outcome,
      costCents: held.costCents,
      limitPrice: held.limitPrice,
      contractsHundredths: outcome.contractsHundredths,
      resolution: outcome.resolution,
      payoutCents: outcome.payoutCents,
      pnlCents: outcome.payoutCents - held.costCents,
      settlementValue: outcome.settlementValue,
      resolvedAt: outcome.resolvedAt,
      venue: venue.kind,
    };
    const hash = hashSettlement(document);
    const signature = await wallet.signMessage({ account: wallet.account, message: settlementMessage(hash) });
    const result = await sink.record({ document, signature });
    switch (result.status) {
      case "stored":
      case "duplicate":
        done.add(intentId);
        filled.delete(intentId);
        if (result.status === "stored") {
          log(
            `${tag} intent #${intentId} SETTLED: ${held.market} resolved ${outcome.resolution.toUpperCase()}; ` +
              `cost ${formatCents(held.costCents)}, paid ${formatCents(outcome.payoutCents)}, ` +
              `net ${formatCents(document.pnlCents)} (${hash})`,
          );
        }
        return;
      case "conflict":
        done.add(intentId);
        filled.delete(intentId);
        log(
          `${tag} intent #${intentId}: the console already holds another settlement (${result.detail}); kept it`,
        );
        return;
      case "retry":
        note(intentId, `settlement not recorded yet: ${result.detail}`);
        backOff(intentId);
        return;
    }
  }

  /**
   * Asks about the positions that are due, and only those: on a pass where none is, it makes no call at
   * all, so an idle machine stays idle.
   */
  async function settlePass(): Promise<void> {
    const sink = options.settlements;
    if (sink === undefined) return;
    const now = clock();
    const due = [...filled]
      .filter(([intentId, { notBefore }]) => !done.has(intentId) && notBefore <= now)
      .map(([intentId]) => intentId)
      .sort((a, b) => a - b);
    const ladders = new Map<string, PositionOutcome>();
    for (const intentId of due) {
      if (isStopped()) return;
      try {
        await settleOne(sink, intentId, ladders);
      } catch (error) {
        note(intentId, `could not settle yet (${errorText(error)}); asking again later`);
        if (filled.has(intentId)) backOff(intentId);
      }
    }
  }

  /** One pass at a time; a pass asked for while one runs waits for it and then runs. */
  function settleNow(): Promise<void> {
    const previous = settling ?? Promise.resolve();
    const next = previous.then(settlePass);
    settling = next.finally(() => {
      if (settling === next) settling = null;
    });
    return next;
  }

  const stopWatching = client.watchEvents({
    ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
    ...(options.pollingIntervalMs === undefined ? {} : { pollingIntervalMs: options.pollingIntervalMs }),
    onEvents: (events) => {
      let newFills = false;
      for (const event of events) {
        if (event.type === "IntentApproved") void handle(event.intentId);
        if (event.type === "ResultRecorded" && event.filled && !done.has(event.intentId)) {
          if (!filled.has(event.intentId)) {
            newFills = true;
            filled.set(event.intentId, { notBefore: 0, waits: 0 });
          }
        }
      }
      // A new fill is looked at right away, which also learns when its market expires.
      if (newFills && options.settlements !== undefined) void settleNow();
    },
    onError: (error) => {
      log(`${tag} polling failed: ${errorText(error)}`);
    },
  });
  const settleTimer =
    options.settlements === undefined ? null : setInterval(() => void settleNow(), settleIntervalMs);

  return {
    stop() {
      stopped = true;
      stopWatching();
      if (settleTimer !== null) clearInterval(settleTimer);
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
    },
    settleNow,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
