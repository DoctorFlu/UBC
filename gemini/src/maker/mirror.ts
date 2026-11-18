/**
 * The mirror maker's prices: what it should have resting on Gemini's sandbox for each rung, from the same
 * contract's book on Gemini's production exchange. A pure function, so the rules are tested without a
 * clock or a network.
 *
 * On a prediction-market book both sides are YES prices: a YES bid at b is also a NO offer at 100 - b,
 * because a NO buyer is matched against YES bids. The maker copies production's best bids:
 *
 *   YES bid  at production's best YES bid (100 minus production's NO ask), sized to its displayed size;
 *   NO bid   at 100 minus production's best YES ask (production's NO bid), sized to the ask's size.
 *
 * Only what production shows is ever quoted. A rung gets no quote when production does not list it, has
 * it in any state but open, shows only one side, or shows a locked or crossed book (the maker's own two
 * bids would then match each other); and none when the sandbox has the rung in any state but open, or
 * when it is close to expiry.
 *
 * Someone else's order on the sandbox book (the executor's NO bid that did not fill at once, say) is met
 * as production would meet it: the maker leaves that side of the rung to them, never competing with them,
 * and keeps quoting the other side at production's price. When production's price there reaches their
 * order, the quote is sent as a plain limit order and fills against it at their price, as it would have on
 * production; every cap still applies, so the inventory caps stop it filling them again and again.
 */
import type { BookLevel } from "../types";

export type MakerOutcome = "yes" | "no";

/** One sandbox rung, with what production and the sandbox show for it at the start of a cycle. */
export interface MirrorRung {
  /** The contract's instrument symbol, the same on both exchanges. */
  symbol: string;
  /** When the rung stops trading, as an epoch in milliseconds; null when unknown (never quoted). */
  expiresAtMs: number | null;
  /** Production's view; null when production does not list the symbol (or could not be read in time). */
  production: {
    marketState: string | null;
    bid: BookLevel | null;
    ask: BookLevel | null;
    /** When this production book was read, epoch milliseconds. */
    readAtMs: number;
  } | null;
  /** Why `production` is null when production could not be read, rather than not listing the symbol. */
  productionUnread?: string;
  sandbox: {
    marketState: string | null;
    /** The sandbox's best YES bid and ask, in cents, as its public data shows them. */
    yesBidCents: number | null;
    yesAskCents: number | null;
  };
}

/** One of the maker's own resting orders, as the account's active orders list it. */
export interface RestingQuote {
  orderId: string;
  symbol: string;
  outcome: MakerOutcome;
  priceCents: number;
  /** Hundredths of a contract still resting. */
  remainingHundredths: number;
}

/** What the account holds on one contract and outcome. */
export interface Holding {
  symbol: string;
  outcome: MakerOutcome;
  hundredths: number;
  /** What it cost, in cents (average price times contracts); 0 when unknown. */
  costCents: number;
}

export interface MakerLimits {
  /** Contracts per quote, in hundredths. */
  maxQuoteHundredths: number;
  /** Cost of one quote if it filled, in cents. */
  maxQuoteNotionalCents: number;
  /** Cost of every quote together if all filled, in cents. */
  maxRestingNotionalCents: number;
  /** Contracts held on one contract and outcome, in hundredths: at it, that side stops quoting. */
  maxRungInventoryHundredths: number;
  /** What everything held cost, in cents: at it, the maker stops quoting altogether. */
  maxInventoryNotionalCents: number;
  /** Quotes are withdrawn this long before a rung expires. */
  closeBeforeMs: number;
  /** A production book older than this is stale: its quotes are withdrawn. */
  staleAfterMs: number;
}

export interface DesiredQuote {
  symbol: string;
  outcome: MakerOutcome;
  priceCents: number;
  hundredths: number;
  /**
   * True when someone else rests on the other side at a price this quote reaches: it is then sent as a
   * plain limit order, which fills against them at their price, instead of maker only.
   */
  mayTake?: boolean;
}

export interface Skip {
  symbol: string;
  /** Unset when the whole rung is skipped. */
  outcome?: MakerOutcome;
  reason: string;
}

export interface MirrorInput {
  /** In the order to fill them: when the resting cap is reached, later rungs get nothing. */
  rungs: readonly MirrorRung[];
  resting: readonly RestingQuote[];
  /**
   * Prices the maker had resting on a side recently (this cycle or just before), by `symbol|outcome`, so
   * that a sandbox book still showing a just-replaced quote is not mistaken for someone else's order.
   */
  recentPrices: ReadonlyMap<string, ReadonlySet<number>>;
  /** Null when the account's positions could not be read: nothing new is quoted then. */
  holdings: readonly Holding[] | null;
  limits: MakerLimits;
  nowMs: number;
}

export interface MirrorPlan {
  quotes: DesiredQuote[];
  skips: Skip[];
}

export function quoteKey(symbol: string, outcome: MakerOutcome): string {
  return `${symbol}|${outcome}`;
}

/** The YES price a resting quote shows in the sandbox book: a NO bid at q is a YES ask at 100 - q. */
function yesPriceOf(outcome: MakerOutcome, priceCents: number): number {
  return outcome === "yes" ? priceCents : 100 - priceCents;
}

function ourPrices(input: MirrorInput, symbol: string, outcome: MakerOutcome): Set<number> {
  const prices = new Set<number>(input.recentPrices.get(quoteKey(symbol, outcome)) ?? []);
  for (const quote of input.resting) {
    if (quote.symbol === symbol && quote.outcome === outcome) prices.add(quote.priceCents);
  }
  return new Set([...prices].map((price) => yesPriceOf(outcome, price)));
}

/** Why a rung gets no quote at all, or null when it may be quoted. */
function rungProblem(rung: MirrorRung, input: MirrorInput): string | null {
  const { limits, nowMs } = input;
  const production = rung.production;
  if (production === null) return rung.productionUnread ?? "production does not list it";
  if (nowMs - production.readAtMs > limits.staleAfterMs) return "production's book is stale";
  if (production.marketState !== "open") return `production has it ${String(production.marketState)}`;
  if (rung.sandbox.marketState !== "open") return `the sandbox has it ${String(rung.sandbox.marketState)}`;
  if (rung.expiresAtMs === null) return "its expiry is unknown";
  if (rung.expiresAtMs - nowMs <= limits.closeBeforeMs) return "it expires soon";
  if (production.bid === null || production.ask === null) return "production shows only one side";
  if (production.ask.priceCents <= production.bid.priceCents) return "production's book is locked or crossed";
  return null;
}

/**
 * The best price someone else rests on the sandbox book for a side of the maker's, as the YES price the
 * book shows: a YES bid at `yesBidCents` for the maker's YES side, a YES offer at `yesAskCents` (someone's
 * NO bid) for its NO side. Null when the best price there is the maker's own, or the side is empty.
 */
function foreignYesPrice(rung: MirrorRung, input: MirrorInput, outcome: MakerOutcome): number | null {
  const shown = outcome === "yes" ? rung.sandbox.yesBidCents : rung.sandbox.yesAskCents;
  if (shown === null || ourPrices(input, rung.symbol, outcome).has(shown)) return null;
  return shown;
}

/** The quotes the maker should have resting, and why each rung or side it leaves out has none. */
export function mirrorQuotes(input: MirrorInput): MirrorPlan {
  const { limits } = input;
  const quotes: DesiredQuote[] = [];
  const skips: Skip[] = [];
  const held = new Map<string, number>();
  let heldCostCents = 0;
  for (const holding of input.holdings ?? []) {
    const key = quoteKey(holding.symbol, holding.outcome);
    held.set(key, (held.get(key) ?? 0) + holding.hundredths);
    heldCostCents += holding.costCents;
  }
  let restingCents = 0;
  for (const rung of input.rungs) {
    const problem = rungProblem(rung, input);
    if (problem !== null) {
      skips.push({ symbol: rung.symbol, reason: problem });
      continue;
    }
    if (input.holdings === null) {
      skips.push({ symbol: rung.symbol, reason: "the account's positions could not be read" });
      continue;
    }
    if (heldCostCents >= limits.maxInventoryNotionalCents) {
      skips.push({ symbol: rung.symbol, reason: "the maker holds as much as it may in all" });
      continue;
    }
    // Checked above: production lists both sides.
    const bid = rung.production?.bid as BookLevel;
    const ask = rung.production?.ask as BookLevel;
    const sides: { outcome: MakerOutcome; priceCents: number; shownHundredths: number }[] = [
      { outcome: "yes", priceCents: bid.priceCents, shownHundredths: bid.quantityHundredths },
      { outcome: "no", priceCents: 100 - ask.priceCents, shownHundredths: ask.quantityHundredths },
    ];
    for (const side of sides) {
      const { outcome, priceCents } = side;
      if (priceCents < 1 || priceCents > 99) {
        skips.push({
          symbol: rung.symbol,
          outcome,
          reason: `production's price gives ${String(priceCents)}c`,
        });
        continue;
      }
      // Someone else rests on this side: the maker never competes with them, so it leaves the side.
      if (foreignYesPrice(rung, input, outcome) !== null) {
        skips.push({
          symbol: rung.symbol,
          outcome,
          reason:
            outcome === "yes"
              ? "the sandbox book has a YES bid that is not ours"
              : "the sandbox book has a YES offer that is not ours",
        });
        continue;
      }
      if ((held.get(quoteKey(rung.symbol, outcome)) ?? 0) >= limits.maxRungInventoryHundredths) {
        skips.push({ symbol: rung.symbol, outcome, reason: "the maker holds as much of it as it may" });
        continue;
      }
      const byNotional = Math.floor((limits.maxQuoteNotionalCents * 100) / priceCents);
      const hundredths = Math.min(side.shownHundredths, limits.maxQuoteHundredths, byNotional);
      // Gemini refuses an order that costs less than a cent.
      if (hundredths <= 0 || hundredths * priceCents < 100) {
        skips.push({ symbol: rung.symbol, outcome, reason: "production's size is too small to quote" });
        continue;
      }
      const costCents = Math.ceil((hundredths * priceCents) / 100);
      if (restingCents + costCents > limits.maxRestingNotionalCents) {
        skips.push({ symbol: rung.symbol, outcome, reason: "the maker's resting total is at its cap" });
        continue;
      }
      restingCents += costCents;
      // Someone else rests on the other side at a price production's own quote reaches: production would
      // have filled them there, so the quote may take it (at their price, never past production's).
      const other = foreignYesPrice(rung, input, outcome === "yes" ? "no" : "yes");
      const mayTake =
        other !== null && (outcome === "yes" ? priceCents >= other : crosses(other, priceCents));
      quotes.push({ symbol: rung.symbol, outcome, priceCents, hundredths, ...(mayTake ? { mayTake } : {}) });
    }
  }
  return { quotes, skips };
}

export interface QuoteChanges {
  /** Resting orders to cancel with nothing placed in their stead: their side has no quote, or is doubled. */
  cancel: RestingQuote[];
  /** Resting orders whose side has a different quote now: the quote is placed, then the order cancelled. */
  replace: Replacement[];
  /** Quotes for a side with nothing resting. */
  place: DesiredQuote[];
  /** Resting orders that already match their quote: left untouched. */
  keep: RestingQuote[];
}

/** A resting order, and the quote that takes its place on the same side. */
export interface Replacement {
  order: RestingQuote;
  quote: DesiredQuote;
}

/**
 * What to change so that what rests matches `desired`: a resting order stays while its price is the
 * quote's and what remains of it is between half the quote's size and the quote's size; otherwise the
 * quote replaces it. Orders on a side with no quote, and any second order on a side, are cancelled.
 */
export function quoteChanges(
  resting: readonly RestingQuote[],
  desired: readonly DesiredQuote[],
): QuoteChanges {
  const want = new Map(desired.map((quote) => [quoteKey(quote.symbol, quote.outcome), quote]));
  const fits = (order: RestingQuote, quote: DesiredQuote) =>
    order.priceCents === quote.priceCents &&
    order.remainingHundredths <= quote.hundredths &&
    order.remainingHundredths * 2 >= quote.hundredths;
  const keep: RestingQuote[] = [];
  const kept = new Set<string>();
  // A fitting order is kept wherever it comes in the list; a side's other orders are cancelled.
  for (const order of resting) {
    const key = quoteKey(order.symbol, order.outcome);
    const quote = want.get(key);
    if (quote !== undefined && !kept.has(key) && fits(order, quote)) {
      keep.push(order);
      kept.add(key);
    }
  }
  const cancel: RestingQuote[] = [];
  const replaced = new Map<string, RestingQuote>();
  for (const order of resting) {
    if (keep.includes(order)) continue;
    const key = quoteKey(order.symbol, order.outcome);
    if (want.has(key) && !kept.has(key) && !replaced.has(key)) replaced.set(key, order);
    else cancel.push(order);
  }
  const replace: Replacement[] = [];
  const place: DesiredQuote[] = [];
  for (const quote of desired) {
    const key = quoteKey(quote.symbol, quote.outcome);
    if (kept.has(key)) continue;
    const order = replaced.get(key);
    if (order === undefined) place.push(quote);
    else replace.push({ order, quote });
  }
  return { cancel, replace, place, keep };
}

/** One placement, and the resting order it replaces (cancelled right after it is placed), if any. */
export interface QuoteStep {
  quote: DesiredQuote;
  replaces: RestingQuote | null;
}

/** Whether a YES bid at `yesCents` and a NO bid at `noCents` on one contract would match each other. */
export function crosses(yesCents: number, noCents: number): boolean {
  return yesCents + noCents >= 100;
}

/**
 * The order to place `changes`' quotes in, after its cancels. A replacement places the new quote before it
 * cancels the order it replaces, so its side is never empty. That needs no new quote to meet the maker's
 * own order on the other side of its contract, and the one way it could is a new YES bid meeting the NO bid
 * it is about to replace (or the reverse). Production's book is not crossed, so at most one of a rung's two
 * sides can meet the other's old order, and that side goes second.
 *
 * Freshest first where a hedge looks first: the YES bids (the NO offers a hedge buys) on rungs below spot,
 * nearest spot first, then the YES bids above spot, nearest first, then the NO bids in the same rung order.
 * A rung is below spot when the market prices its YES at 50c or more.
 */
export function quoteSteps(changes: Pick<QuoteChanges, "replace" | "place">): QuoteStep[] {
  const steps: QuoteStep[] = [
    ...changes.replace.map(({ order, quote }) => ({ quote, replaces: order })),
    ...changes.place.map((quote) => ({ quote, replaces: null })),
  ];
  const bySymbol = new Map<string, { yes?: QuoteStep; no?: QuoteStep }>();
  for (const step of steps) {
    const rung = bySymbol.get(step.quote.symbol) ?? {};
    rung[step.quote.outcome] = step;
    bySymbol.set(step.quote.symbol, rung);
  }
  const yesPrice = (rung: { yes?: QuoteStep; no?: QuoteStep }) =>
    rung.yes ? rung.yes.quote.priceCents : 100 - (rung.no?.quote.priceCents ?? 50);
  // Below spot first (YES at 50c or more), and nearest spot first on each side of it.
  const rank = (price: number): [number, number] => (price >= 50 ? [0, price] : [1, -price]);
  const rungs = [...bySymbol.values()].sort((a, b) => {
    const [sideA, nearA] = rank(yesPrice(a));
    const [sideB, nearB] = rank(yesPrice(b));
    return sideA - sideB || nearA - nearB;
  });
  const ordered: QuoteStep[] = [];
  const add = (step: QuoteStep | undefined) => {
    if (step !== undefined && !ordered.includes(step)) ordered.push(step);
  };
  for (const rung of rungs) {
    const oldNo = rung.no?.replaces;
    // The new YES bid would meet the NO bid it is about to replace: that NO bid is replaced first.
    if (rung.yes && oldNo && crosses(rung.yes.quote.priceCents, oldNo.priceCents)) add(rung.no);
    add(rung.yes);
  }
  for (const rung of rungs) add(rung.no);
  return ordered;
}
