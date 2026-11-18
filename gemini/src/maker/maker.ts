/**
 * The mirror maker (`npm run gemini:maker`): keeps quotes resting on Gemini's sandbox at the prices
 * Gemini's production exchange shows for the same contracts, so that the sandbox's empty ladders can be
 * traded at real market prices. Orders and fills happen on the sandbox's matching engine and settle there
 * on the real index; the only synthetic part is the counterparty, which is this process on an account of
 * its own.
 *
 * Each cycle reads production's public books, the sandbox's public listing, and the maker account's open
 * orders and positions, then cancels what no longer matches and places what is missing, maker only (an
 * order that would take liquidity is cancelled by Gemini instead of filling). It cancels every order of
 * its own when it starts and when it stops, and touches no order without its client order id prefix.
 */
import { isGeminiPrivateError } from "../private-errors";
import type { GeminiPrivateClient, PrivateOrder } from "../private";
import type { EventSummary, MarketEvent, OrderBook } from "../types";
import { toCents, toHundredths } from "../units";
import {
  mirrorQuotes,
  quoteChanges,
  quoteKey,
  type DesiredQuote,
  type Holding,
  type MakerOutcome,
  type MirrorPlan,
  type MirrorRung,
  type RestingQuote,
  type Skip,
} from "./mirror";
import { MAKER_ORDER_PREFIX, type MakerSettings } from "./settings";

/** The public market data the maker reads: `GeminiClient` has it. */
export interface MarketReader {
  listEvents(options: { asset: string }): Promise<EventSummary[]>;
  getEvent(eventTicker: string): Promise<MarketEvent>;
  getOrderBook(instrumentSymbol: string): Promise<OrderBook>;
}

export interface MakerDeps {
  /** Production's public data: the prices. */
  production: MarketReader;
  /** The sandbox's public data: what it lists, and what its books show. */
  sandbox: MarketReader;
  /** The maker's own account on the sandbox. */
  account: GeminiPrivateClient;
  settings: Pick<
    MakerSettings,
    "kinds" | "assets" | "intervalMs" | "limits" | "maxPlacementsPerCycle" | "discoveryMs"
  >;
  say: (line: string) => void;
  now?: () => number;
  /** The random part of each client order id. */
  newId?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface MakerView {
  rungs: MirrorRung[];
  /** Event tickers whose sandbox data could not be read this cycle: their quotes are left as they are. */
  frozen: Set<string>;
  /** The maker's own resting buy orders. */
  resting: RestingQuote[];
  /** The maker's own orders that are not buys (it never places one; they are cancelled). */
  strays: PrivateOrder[];
  /** Null when the account's positions could not be read. */
  holdings: Holding[] | null;
  plan: MirrorPlan;
  nowMs: number;
}

export interface CycleReport {
  rungs: number;
  quotes: number;
  kept: number;
  placed: number;
  cancelled: number;
  /** Quotes Gemini cancelled at once because they would have taken liquidity, or refused. */
  refused: number;
  skips: Skip[];
}

const MAX_CANCEL_ROUNDS = 20;
/** How long a refused price is not tried again on the same side (it is tried at once at a new price). */
const REFUSAL_HOLD_MS = 5 * 60_000;

function decimal(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  return rest === 0 ? String(whole) : `${String(whole)}.${String(rest).padStart(2, "0")}`;
}

function price(cents: number): string {
  return `0.${String(cents).padStart(2, "0")}`;
}

function isOurs(order: PrivateOrder): boolean {
  return order.clientOrderId?.startsWith(MAKER_ORDER_PREFIX) === true;
}

function restingOf(order: PrivateOrder): RestingQuote | null {
  const outcome = order.outcome.toLowerCase();
  const priceCents = toCents(order.price, "half-up");
  const remaining =
    toHundredths(order.remainingQuantity ?? null) ??
    (() => {
      const total = toHundredths(order.quantity);
      const filled = toHundredths(order.filledQuantity ?? "0") ?? 0;
      return total === null ? null : total - filled;
    })();
  if ((outcome !== "yes" && outcome !== "no") || priceCents === null || remaining === null) return null;
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    outcome,
    priceCents,
    remainingHundredths: remaining,
  };
}

function message(error: unknown): string {
  if (isGeminiPrivateError(error))
    return `${error.kind}${error.reason ? ` (${error.reason})` : ""}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function defaultId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class MirrorMaker {
  readonly #deps: MakerDeps;
  readonly #now: () => number;
  readonly #newId: () => string;
  #events: string[] = [];
  #discoveredAt = Number.NEGATIVE_INFINITY;
  /** Production's last good book per symbol; dropped when production stops listing it. */
  readonly #production = new Map<string, NonNullable<MirrorRung["production"]>>();
  /** Prices the maker had resting on each side, with when, so its own fading quotes are not foreign. */
  readonly #recent = new Map<string, Map<number, number>>();
  /** A side whose placement got no answer: left alone until this time, then read from the account. */
  readonly #pending = new Map<string, number>();
  readonly #refused = new Map<string, { priceCents: number; atMs: number }>();
  /** The last reason logged per rung or side, so a reason is logged when it changes, not every cycle. */
  readonly #lastReason = new Map<string, string>();

  constructor(deps: MakerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? defaultId;
  }

  /** Cancels every open order of the maker's (its client order id prefix). Returns how many it cancelled. */
  async cancelAll(): Promise<number> {
    const { account, say } = this.#deps;
    let cancelled = 0;
    const failed = new Set<string>();
    for (let round = 0; round < MAX_CANCEL_ROUNDS; round += 1) {
      const open = await account.activeOrders();
      const ours = open.filter((order) => isOurs(order) && !failed.has(order.orderId));
      if (round === 0) {
        const others = open.length - open.filter(isOurs).length;
        if (others > 0)
          say(`${String(others)} open order(s) on the maker's account are not the maker's: left alone`);
      }
      if (ours.length === 0) break;
      for (const order of ours) {
        try {
          await account.cancelOrder(order.orderId);
          cancelled += 1;
        } catch (error) {
          failed.add(order.orderId);
          say(`could not cancel order ${order.orderId} (${order.symbol}): ${message(error)}`);
        }
      }
    }
    if (failed.size > 0)
      throw new Error(`${String(failed.size)} of the maker's orders could not be cancelled`);
    return cancelled;
  }

  /** Runs until `signal` aborts: cancels everything first, then a cycle per interval, and everything again at the end. */
  async run(signal: AbortSignal): Promise<void> {
    const { say, settings } = this.#deps;
    const sleep = this.#deps.sleep ?? defaultSleep;
    const first = await this.cancelAll();
    say(
      `started: cancelled ${String(first)} order(s) left from an earlier run; quoting ${settings.kinds.join(", ")} ladders of ${settings.assets.join(", ")} every ${String(settings.intervalMs / 1000)} s`,
    );
    try {
      while (!signal.aborted) {
        try {
          await this.cycle();
        } catch (error) {
          say(`cycle failed, nothing more changed this cycle: ${message(error)}`);
        }
        await sleep(settings.intervalMs, signal);
      }
    } finally {
      const last = await this.cancelAll();
      say(`stopped: cancelled ${String(last)} order(s)`);
    }
  }

  /**
   * Reads both exchanges and the account, and works out what should rest, changing nothing. The doctor
   * shows it; `cycle` acts on it.
   */
  async view(): Promise<MakerView> {
    const { account, settings } = this.#deps;
    await this.#discover();
    const { rungs, frozen } = await this.#rungs();
    const open = await account.activeOrders();
    const resting = open
      .filter((order) => isOurs(order) && order.side.toLowerCase() === "buy")
      .map(restingOf)
      .filter((quote): quote is RestingQuote => quote !== null);
    const strays = open.filter((order) => isOurs(order) && order.side.toLowerCase() !== "buy");
    let holdings: Holding[] | null;
    try {
      holdings = (await account.positions()).flatMap((position): Holding[] => {
        const outcome = position.outcome.toLowerCase();
        const hundredths = toHundredths(position.totalQuantity);
        if ((outcome !== "yes" && outcome !== "no") || hundredths === null) return [];
        const average = toCents(position.avgPrice ?? null, "up") ?? 0;
        return [
          {
            symbol: position.symbol,
            outcome,
            hundredths,
            costCents: Math.ceil((hundredths * average) / 100),
          },
        ];
      });
    } catch (error) {
      holdings = null;
      this.#note("positions", `the account's positions could not be read: ${message(error)}`);
    }
    const nowMs = this.#now();
    this.#forget(nowMs);
    const plan = mirrorQuotes({
      rungs,
      resting,
      recentPrices: this.#recentPrices(),
      holdings,
      limits: settings.limits,
      nowMs,
    });
    return { rungs, frozen, resting, strays, holdings, plan, nowMs };
  }

  /** One pass: read both exchanges and the account, then bring the resting quotes in line. */
  async cycle(): Promise<CycleReport> {
    const { account, settings, say } = this.#deps;
    const { rungs, frozen, resting, strays, plan, nowMs } = await this.view();
    const untouched = (symbol: string, outcome: MakerOutcome) =>
      [...frozen].some((ticker) => symbol.includes(`-${ticker}-`)) ||
      (this.#pending.get(quoteKey(symbol, outcome)) ?? 0) > nowMs;
    const refusedHere = (quote: DesiredQuote) => {
      const refusal = this.#refused.get(quoteKey(quote.symbol, quote.outcome));
      return refusal !== undefined && refusal.priceCents === quote.priceCents;
    };
    const desired = plan.quotes.filter(
      (quote) => !untouched(quote.symbol, quote.outcome) && !refusedHere(quote),
    );
    const changes = quoteChanges(
      resting.filter((quote) => !untouched(quote.symbol, quote.outcome)),
      desired,
    );
    let cancelled = 0;
    for (const order of [
      ...changes.cancel,
      ...strays.map((order) => ({ orderId: order.orderId, symbol: order.symbol })),
    ]) {
      try {
        await account.cancelOrder(order.orderId);
        cancelled += 1;
      } catch (error) {
        say(`could not cancel order ${order.orderId} (${order.symbol}): ${message(error)}`);
      }
    }
    let placed = 0;
    let refused = 0;
    for (const quote of changes.place.slice(0, settings.maxPlacementsPerCycle)) {
      const key = quoteKey(quote.symbol, quote.outcome);
      try {
        const order = await account.placeOrder({
          symbol: quote.symbol,
          side: "buy",
          outcome: quote.outcome,
          quantity: decimal(quote.hundredths),
          price: price(quote.priceCents),
          clientOrderId: `${MAKER_ORDER_PREFIX}${this.#newId()}`,
          makerOrCancel: true,
        });
        this.#remember(key, quote.priceCents, this.#now());
        if (order.status.toLowerCase() === "cancelled") {
          refused += 1;
          this.#refused.set(key, { priceCents: quote.priceCents, atMs: this.#now() });
          this.#note(
            key,
            `${quote.outcome.toUpperCase()} bid at ${String(quote.priceCents)}c on ${quote.symbol} would have taken liquidity: skipped until production moves`,
          );
        } else {
          placed += 1;
        }
      } catch (error) {
        if (isGeminiPrivateError(error) && error.outcomeUnknown) {
          this.#pending.set(key, this.#now() + 2 * settings.intervalMs);
          say(
            `no answer placing ${quote.outcome.toUpperCase()} bid on ${quote.symbol}; looking it up in the account before quoting that side again`,
          );
        } else {
          refused += 1;
          this.#refused.set(key, { priceCents: quote.priceCents, atMs: this.#now() });
          this.#note(
            key,
            `${quote.outcome.toUpperCase()} bid at ${String(quote.priceCents)}c on ${quote.symbol} refused: ${message(error)}`,
          );
        }
      }
    }
    for (const skip of plan.skips) {
      this.#note(
        skip.outcome ? quoteKey(skip.symbol, skip.outcome) : skip.symbol,
        `${skip.symbol}${skip.outcome ? ` ${skip.outcome.toUpperCase()}` : ""}: not quoted, ${skip.reason}`,
      );
    }
    for (const quote of plan.quotes) {
      this.#lastReason.delete(quote.symbol);
      this.#lastReason.delete(quoteKey(quote.symbol, quote.outcome));
    }
    const report: CycleReport = {
      rungs: rungs.length,
      quotes: plan.quotes.length,
      kept: changes.keep.length,
      placed,
      cancelled,
      refused,
      skips: plan.skips,
    };
    if (placed + cancelled + refused > 0) {
      say(
        `cycle: ${String(rungs.length)} rungs, ${String(plan.quotes.length)} quotes wanted, ${String(changes.keep.length)} kept, ${String(placed)} placed, ${String(cancelled)} cancelled, ${String(refused)} refused`,
      );
    }
    return report;
  }

  async #discover(): Promise<void> {
    const { sandbox, settings, say } = this.#deps;
    if (this.#now() - this.#discoveredAt < settings.discoveryMs) return;
    try {
      const found: { ticker: string; kind: number; expiry: string }[] = [];
      for (const asset of settings.assets) {
        for (const event of await sandbox.listEvents({ asset })) {
          const kind = settings.kinds.indexOf(event.kind as never);
          if (kind < 0 || (event.status !== null && event.status !== "active")) continue;
          found.push({ ticker: event.ticker, kind, expiry: event.expiry ?? "" });
        }
      }
      found.sort((a, b) => a.kind - b.kind || a.expiry.localeCompare(b.expiry));
      const tickers = found.map((event) => event.ticker);
      if (tickers.join() !== this.#events.join()) say(`ladders in scope: ${tickers.join(", ") || "none"}`);
      this.#events = tickers;
      this.#discoveredAt = this.#now();
    } catch (error) {
      this.#note("discovery", `the sandbox's listings could not be read: ${message(error)}`);
    }
  }

  /**
   * The rungs of every ladder in scope. A ladder whose sandbox data could not be read is frozen: its quotes
   * are neither placed nor cancelled this cycle. Production's book is read for each rung the sandbox lists;
   * when production cannot be read, its last book is used until it is stale.
   */
  async #rungs(): Promise<{ rungs: MirrorRung[]; frozen: Set<string> }> {
    // `frozen` holds event tickers; a contract's symbol names its event (GEMI-<event>-<contract>).
    const { sandbox, production } = this.#deps;
    const rungs: MirrorRung[] = [];
    const frozen = new Set<string>();
    for (const ticker of this.#events) {
      let event: MarketEvent;
      try {
        event = await sandbox.getEvent(ticker);
      } catch (error) {
        this.#note(`sandbox:${ticker}`, `the sandbox's ${ticker} could not be read: ${message(error)}`);
        frozen.add(ticker);
        continue;
      }
      if (!event.isLadder) continue;
      let listed: Map<string, string | null> | null = null;
      try {
        const theirs = await production.getEvent(ticker);
        listed = new Map(
          theirs.contracts.map((contract) => [contract.instrumentSymbol, contract.marketState]),
        );
      } catch (error) {
        this.#note(`production:${ticker}`, `production's ${ticker} could not be read: ${message(error)}`);
      }
      for (const contract of event.contracts) {
        const symbol = contract.instrumentSymbol;
        if (listed !== null) {
          if (!listed.has(symbol)) {
            this.#production.delete(symbol);
          } else {
            try {
              const book = await production.getOrderBook(symbol);
              this.#production.set(symbol, {
                marketState: listed.get(symbol) ?? null,
                bid: book.bids[0] ?? null,
                ask: book.asks[0] ?? null,
                readAtMs: this.#now(),
              });
            } catch (error) {
              this.#note(
                `book:${symbol}`,
                `production's book for ${symbol} could not be read: ${message(error)}`,
              );
            }
          }
        }
        const expiry = Date.parse(contract.expiry ?? event.expiry ?? "");
        const last = this.#production.get(symbol);
        rungs.push({
          symbol,
          expiresAtMs: Number.isFinite(expiry) ? expiry : null,
          ...(last === undefined && (listed === null || listed.has(symbol))
            ? { productionUnread: "production could not be read" }
            : {}),
          production: this.#production.get(symbol) ?? null,
          sandbox: {
            marketState: contract.marketState,
            yesBidCents: contract.quote.yesBidCents,
            yesAskCents: contract.quote.yesAskCents,
          },
        });
      }
    }
    return { rungs, frozen };
  }

  #remember(key: string, priceCents: number, atMs: number): void {
    const prices = this.#recent.get(key) ?? new Map<number, number>();
    prices.set(priceCents, atMs);
    this.#recent.set(key, prices);
  }

  #recentPrices(): Map<string, Set<number>> {
    return new Map([...this.#recent].map(([key, prices]) => [key, new Set(prices.keys())]));
  }

  /** Drops what is old: recent prices after a minute, refusals after `REFUSAL_HOLD_MS`, answered waits. */
  #forget(nowMs: number): void {
    const keepFor = Math.max(60_000, 3 * this.#deps.settings.intervalMs);
    for (const [key, prices] of this.#recent) {
      for (const [priceCents, atMs] of prices) if (nowMs - atMs > keepFor) prices.delete(priceCents);
      if (prices.size === 0) this.#recent.delete(key);
    }
    for (const [key, refusal] of this.#refused)
      if (nowMs - refusal.atMs > REFUSAL_HOLD_MS) this.#refused.delete(key);
    for (const [key, until] of this.#pending) if (until <= nowMs) this.#pending.delete(key);
  }

  /** Logs `line` for `topic` only when it differs from the last line logged for it. */
  #note(topic: string, line: string): void {
    if (this.#lastReason.get(topic) === line) return;
    this.#lastReason.set(topic, line);
    this.#deps.say(line);
  }
}
