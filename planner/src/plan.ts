/**
 * The hedge planner: turns a strike ladder into a staircase of NO contracts that offsets a
 * holding's loss between a ceiling and a floor.
 *
 * The maths. A contract "asset at or above K" pays $1 to NO when the final price is below K.
 * Holding q units, the loss from the ceiling C down to a price P is q x (C - P). Walking the
 * strikes below C from the top, K1 > K2 > ..., the rung at Ki buys
 *
 *     n_i = q x (K_{i-1} - max(K_i, F))   contracts, with K_0 = C,
 *
 * so the moment the price drops below Ki the payout has caught up with the loss from C to Ki.
 * The last rung is the first strike at or below the floor F, sized only for the slice down to F.
 * Quantities are rounded down to the 0.01 contract increment.
 *
 * Invariant (never over-hedge): for every final price P,
 *
 *     hedge payout(P) <= q x (C - max(P, F))   (and 0 at or above C),
 *
 * because payout(P) is the sum of n_i over strikes above P, each n_i is at most its slice of
 * the loss, and dropping or scaling rungs only lowers it. The ceiling defaults to spot, so by
 * default the hedge never pays more than the holding actually loses; the top rung is then the
 * highest strike below spot, sized for the drop from spot to it. A ceiling above spot is
 * allowed only up to the first strike at or above spot (this snaps the first step to the
 * strike grid, as in the design-doc example); the plan then states exactly how much the payout
 * can exceed the loss measured from spot.
 *
 * The result approximates a put spread from C to F: between strikes the payout lags the loss
 * by at most one strike step of exposure (q x gap).
 */
import type { LadderRung } from "@mandate/gemini";
import { assessCover, measureCover } from "./cover";
import { rungOffer, type RungOffer } from "./depth";
import { planIdFor } from "./id";
import { orderBySignal, rateRung, readSignal, shortId, type SignalContext } from "./signal";
import { designStaircase, resolveCeiling, resolveFloor, type DesignedRung as Designed } from "./staircase";
import type {
  CoverAssessment,
  DepthOption,
  HeldPosition,
  HedgeInput,
  HedgePlan,
  PayoffPoint,
  PlannedOrder,
  PlanCover,
  PlannedRung,
  PlanSignalUse,
  PlanWarning,
  SignalRungRating,
  UncoveredSlice,
  WarningCode,
} from "./types";
import {
  ceilDiv,
  formatContracts,
  formatHoldingUnits,
  formatPrice,
  formatUsd,
  HOLDING_SCALE,
  holdingCents,
  orderAmountCents,
  parseHoldingUnits,
  PlannerInputError,
  requireInteger,
} from "./units";

interface DesignedRung extends Designed {
  /**
   * Contracts to buy at this strike: the designed size, or with positions held, only what is missing
   * from the goal (`CoverRung.missingHundredths`).
   */
  wantHundredths: number;
}

type Rating = Omit<SignalRungRating, "boughtHundredths">;

interface Context {
  input: HedgeInput;
  asset: string;
  units: bigint;
  spotCents: number;
  ceilingCents: number | null;
  floorCents: number | null;
  spendCapCents: number;
  rungs: PlannedRung[];
  warnings: PlanWarning[];
  uncovered: UncoveredSlice[];
  /** The paid signal, when one was given. */
  signal: SignalContext | null;
  /** The signal's rating of each designed rung, highest strike first. */
  ratings: Rating[];
  /** Cover already held, when the input gave positions. */
  cover: CoverAssessment | null;
  /** Whether to measure what higher slippages would buy (`HedgePlan.depthOptions`): not for those plans themselves. */
  withOptions: boolean;
  /** The plan's `thin_depth` warning, when the book was too thin somewhere. */
  thinDepth: PlanWarning | null;
}

/** The highest slippage `plan_hedge` takes, and so the last one `depthOptions` measures. */
export const MAX_SLIPPAGE_CENTS = 10;

export function planHedge(input: HedgeInput): HedgePlan {
  return plan(input, true);
}

function plan(input: HedgeInput, withOptions: boolean): HedgePlan {
  const units = parseHoldingUnits(input.holding.quantity);
  const asset = input.holding.asset.trim().toUpperCase();
  if (input.ladder.asset.toUpperCase() !== asset) {
    throw new PlannerInputError(`The ladder is for ${input.ladder.asset}, but the holding is ${asset}`);
  }
  const spotCents = input.spotCents ?? input.ladder.spot.midCents;
  requireInteger(spotCents, "spotCents", 1);
  requireInteger(input.maxCostCents, "maxCostCents");
  requireInteger(input.limits.maxTradeCents, "limits.maxTradeCents");
  requireInteger(input.limits.remainingBudgetCents, "limits.remainingBudgetCents");
  const slippage = input.slippageCents ?? 0;
  requireInteger(slippage, "slippageCents");
  for (const [symbol, depth] of Object.entries(input.depthHundredths ?? {})) {
    requireInteger(depth, `depthHundredths[${symbol}]`);
  }
  const signal = input.signal === undefined ? null : readSignal(input.signal, input.ladder);

  const ctx: Context = {
    input,
    asset,
    units,
    spotCents,
    ceilingCents: null,
    floorCents: null,
    spendCapCents: Math.min(input.maxCostCents, input.limits.remainingBudgetCents),
    rungs: [],
    warnings: [],
    uncovered: [],
    signal,
    ratings: [],
    cover: null,
    withOptions,
    thinDepth: null,
  };
  if (signal !== null) warnIfIgnored(ctx, signal);
  // The goal is designed over the ladder's strikes and production's for the same event (`elsewhere`).
  const onEvent = { ...input.ladder, elsewhere: input.elsewhere ?? [] };

  if (!input.limits.categoryAllowed) {
    warn(
      ctx,
      "category_not_allowed",
      "The policy does not allow trading this market category, so no hedge is planned.",
    );
    // Cover is a fact about positions, whatever the rules allow now.
    if (input.held !== undefined) {
      ctx.cover = assessCover({
        holding: input.holding,
        ladder: onEvent,
        spotCents,
        goal: input.goal,
        held: input.held,
      });
    }
    return finalize(ctx);
  }

  // What is covered: the goal over the ladder's strikes and production's (`coverStrikes`). What can be
  // added: the ladder's strikes only, below.
  const heldCover =
    input.held === undefined
      ? null
      : assessCover({
          holding: input.holding,
          ladder: onEvent,
          spotCents,
          goal: input.goal,
          held: input.held,
        });
  const ascending = [...input.ladder.rungs].sort((a, b) => a.strikeCents - b.strikeCents);
  const descending = [...ascending].reverse();
  const floorCents = resolveFloor(input.goal, spotCents);
  // A floor at or above spot calls for nothing on any ladder: said first, before anything about strikes.
  if (input.goal.ceilingCents === undefined && floorCents >= spotCents) {
    ctx.floorCents = floorCents;
    warn(ctx, "floor_not_below_ceiling", floorAtOrAboveSpot(floorCents, spotCents, input.held));
    return finalizeWithCover(ctx, heldCover);
  }
  const ceilingCents = resolveCeiling(
    units,
    spotCents,
    input.goal.ceilingCents,
    ascending,
    (code, message) => {
      warn(ctx, code, message);
    },
  );
  if (ceilingCents === null) return finalizeWithCover(ctx, heldCover);
  ctx.ceilingCents = ceilingCents;
  ctx.floorCents = floorCents;
  if (floorCents >= ceilingCents) {
    warn(
      ctx,
      "floor_not_below_ceiling",
      `The floor ${formatPrice(floorCents)} is not below where protection starts (${formatPrice(ceilingCents)}), so there is nothing to protect.`,
    );
    return finalizeWithCover(ctx, heldCover);
  }

  const designed = design(ctx, descending, ceilingCents, floorCents);
  if (input.held !== undefined && heldCover !== null) {
    ctx.cover = heldCover;
    if (heldCover.state === "met") {
      warn(ctx, "already_covered", alreadyCovered(heldCover));
      return finalize(ctx);
    }
    // The top-up on the ladder's own strikes: positions at strikes it does not list still pay below
    // each of its strikes, so they count toward every rung under them.
    const onLadder = measureCover({
      asset,
      eventTicker: input.ladder.eventTicker,
      spotCents,
      units,
      ceilingCents,
      floorCents,
      designed,
      held: input.held,
    });
    const missing = new Map(onLadder.rungs.map((r) => [r.instrumentSymbol, r.missingHundredths]));
    for (const d of designed) d.wantHundredths = missing.get(d.rung.instrumentSymbol) ?? 0;
  }
  buy(ctx, designed, slippage);
  return finalize(ctx);
}

/**
 * Finalizes a plan that buys nothing on this ladder (no staircase on its strikes), with the cover the
 * positions held give, measured on their own strikes too.
 */
function finalizeWithCover(ctx: Context, heldCover: CoverAssessment | null): HedgePlan {
  if (heldCover !== null) {
    ctx.cover = heldCover;
    if (heldCover.state === "met") warn(ctx, "already_covered", alreadyCovered(heldCover));
  }
  return finalize(ctx);
}

/**
 * Why a plan buys nothing when the price is at or below the floor. With positions held that pay below
 * today's price, never "nothing to protect": that is the moment the protection is for.
 */
function floorAtOrAboveSpot(
  floorCents: number,
  spotCents: number,
  held: readonly HeldPosition[] | undefined,
): string {
  const pays = (held ?? [])
    .filter((p) => p.strikeCents > spotCents)
    .reduce((sum, p) => sum + p.hundredths, 0);
  return pays > 0
    ? `The price (${formatPrice(spotCents)}) is at or below the floor ${formatPrice(floorCents)}, so a plan buys nothing more: the goal calls for no contracts below the floor. The contracts held pay ${formatPrice(pays)} if it settles at today's price.`
    : `The floor ${formatPrice(floorCents)} is not below where protection starts (${formatPrice(spotCents)}), so there is nothing to protect.`;
}

/** The warning for a goal the positions already cover, in plain words with the numbers. */
function alreadyCovered(cover: CoverAssessment): string {
  const below = formatPrice(cover.measuredBelowCents ?? 0);
  const parts = (
    [
      ["filled", cover.heldByState.filled],
      ["waiting to fill", cover.heldByState.awaiting_fill],
      ["waiting for the owner's approval", cover.heldByState.awaiting_owner],
    ] as const
  )
    .filter(([, cents]) => cents > 0)
    .map(([label, cents]) => `${formatUsd(cents)} ${label}`);
  return `The ${cover.holdingQuantity} ${cover.asset} is already covered below ${below}: the contracts held pay ${formatUsd(cover.heldPayoutCents)} there (${parts.join(", ")}), ${formatBps(cover.coverBps ?? 0)} of the ${formatUsd(cover.targetPayoutCents)} the goal calls for, so nothing more is bought.`;
}

/** "99%", "100%", "212%" from basis points, rounded down. */
function formatBps(bps: number): string {
  return `${Math.floor(bps / 100).toString()}%`;
}

const IGNORED_BECAUSE: Record<NonNullable<PlanSignalUse["ignoredBecause"]>, string> = {
  asset_mismatch: "is for a different asset",
  event_mismatch: "is for a different ladder",
  no_matching_strikes: "has none of this ladder's strikes",
};

function warnIfIgnored(ctx: Context, signal: SignalContext): void {
  if (signal.ignoredBecause === null) return;
  warn(
    ctx,
    "signal_ignored",
    `The paid signal (receipt ${shortId(signal.paid.receiptId)}) ${IGNORED_BECAUSE[signal.ignoredBecause]}, so the plan does not use it.`,
  );
}

function design(
  ctx: Context,
  descending: LadderRung[],
  ceilingCents: number,
  floorCents: number,
): DesignedRung[] {
  const staircase = designStaircase(ctx.units, descending, ceilingCents, floorCents);
  const designed = staircase.designed.map((d) => ({ ...d, wantHundredths: d.designedHundredths }));
  const previous = staircase.tailFromCents ?? floorCents;
  if (staircase.tailFromCents !== null) {
    const shortfall = holdingCents(ctx.units, previous - floorCents);
    ctx.uncovered.push({
      code: "no_tail_protection",
      fromCents: previous,
      toCents: floorCents,
      shortfallCents: shortfall,
      strikeCents: null,
    });
    warn(
      ctx,
      "no_tail_protection",
      designed.length === 0
        ? `No strike lies below ${formatPrice(ceilingCents)}, so the ladder cannot protect down to ${formatPrice(floorCents)}.`
        : `The lowest strike is ${formatPrice(previous)}, so nothing protects the fall from there to the floor ${formatPrice(floorCents)} (up to ${formatUsd(shortfall)}).`,
    );
  }
  return designed;
}

function buy(ctx: Context, staircase: DesignedRung[], slippage: number): void {
  const { input } = ctx;
  // With a usable signal, rungs are bought cheapest first, so a spend cap that cannot cover every
  // rung cuts the expensive ones. Without one, nearest spot first. Which strikes the staircase uses
  // and how many contracts each needs do not change.
  const signal = ctx.signal?.ignoredBecause === null ? ctx.signal : null;
  const ratingOf = new Map<string, Rating>();
  const override = (d: DesignedRung) => input.depthHundredths?.[d.rung.instrumentSymbol];
  if (signal !== null) {
    // Each rung is rated at the limit the plan would pay for all it wants there.
    ctx.ratings = staircase.map((d) => {
      const priced = d.rung.noBuyCents !== null && d.rung.noBuyCents >= 1 && d.rung.noBuyCents <= 99;
      if (!priced) return rateRung(signal, d.rung, slippage);
      const offer = rungOffer(d.rung, slippage, override(d));
      const want = Math.min(d.wantHundredths, offer.availableHundredths ?? d.wantHundredths);
      return rateRung(signal, d.rung, offer.limitFor(want) - (d.rung.noBuyCents ?? 0));
    });
    for (const rating of ctx.ratings) ratingOf.set(rating.instrumentSymbol, rating);
  }
  const designed =
    signal === null
      ? staircase
      : orderBySignal(staircase, (d) => ratingOf.get(d.rung.instrumentSymbol)?.rating ?? "unrated");
  const budgetIsTighter = input.limits.remainingBudgetCents < input.maxCostCents;
  const capCode: WarningCode = budgetIsTighter ? "budget_exhausted" : "cost_cap_reached";
  const skipped = new Map<WarningCode, number[]>();
  const note = (code: WarningCode, d: DesignedRung, shortfall: number) => {
    skipped.set(code, [...(skipped.get(code) ?? []), d.rung.strikeCents]);
    if (shortfall > 0) {
      ctx.uncovered.push({
        code,
        fromCents: d.coversFromCents,
        toCents: d.coversToCents,
        shortfallCents: shortfall,
        strikeCents: d.rung.strikeCents,
      });
    }
  };
  const thin: string[] = [];
  const capped: string[] = [];
  const split: number[] = [];
  let spent = 0;
  let capReached = false;

  for (const d of designed) {
    const { rung } = d;
    let want = d.wantHundredths;
    if (d.designedHundredths < 1) {
      note("below_minimum", d, 0);
      continue;
    }
    // Positions already held cover this rung.
    if (want < 1) continue;
    if (rung.marketState !== "open") {
      note("market_not_open", d, want);
      continue;
    }
    if (rung.noBuyCents === null || rung.noBuyCents < 1 || rung.noBuyCents > 99) {
      note("no_price", d, want);
      continue;
    }
    if (capReached) {
      capped.push(`${formatPrice(rung.strikeCents)} dropped`);
      note(capCode, d, want);
      continue;
    }
    const offer = rungOffer(rung, slippage, override(d));
    const depth = offer.availableHundredths;
    if (depth !== undefined && depth < want) {
      thin.push(`${formatPrice(rung.strikeCents)} (${formatContracts(depth)} of ${formatContracts(want)})`);
      note("thin_depth", d, want - depth);
      want = depth;
      if (want < 1) continue;
    }
    const perOrderMaxAt = (priceCents: number) => Math.floor((input.limits.maxTradeCents * 100) / priceCents);
    if (perOrderMaxAt(offer.limitFor(1)) < 1) {
      note("trade_cap_too_small", d, want);
      continue;
    }
    const affordable = maxAffordable(want, offer, perOrderMaxAt, ctx.spendCapCents - spent);
    if (affordable < want) {
      capReached = true;
      capped.push(
        affordable === 0
          ? `${formatPrice(rung.strikeCents)} dropped`
          : `${formatPrice(rung.strikeCents)} scaled to ${formatContracts(affordable)} of ${formatContracts(want)}`,
      );
      note(capCode, d, want - affordable);
      if (affordable === 0) continue;
    }
    const limitPriceCents = offer.limitFor(affordable);
    const perOrderMax = perOrderMaxAt(limitPriceCents);
    const orders = splitOrder(affordable, perOrderMax).map((quantityHundredths): PlannedOrder => ({
      instrumentSymbol: rung.instrumentSymbol,
      strikeCents: rung.strikeCents,
      side: "no",
      quantity: formatContracts(quantityHundredths),
      quantityHundredths,
      limitPriceCents,
      amountCents: orderAmountCents(quantityHundredths, limitPriceCents),
    }));
    if (orders.length > 1) split.push(rung.strikeCents);
    const amountCents = orders.reduce((sum, o) => sum + o.amountCents, 0);
    spent += amountCents;
    ctx.rungs.push({
      instrumentSymbol: rung.instrumentSymbol,
      strikeCents: rung.strikeCents,
      side: "no",
      quantity: formatContracts(affordable),
      quantityHundredths: affordable,
      designedHundredths: d.designedHundredths,
      limitPriceCents,
      amountCents,
      payoutCents: affordable,
      coversFromCents: d.coversFromCents,
      coversToCents: d.coversToCents,
      orders,
      bestPriceCents: rung.noBuyCents,
      levelsUsed: offer.levelsFor(affordable),
      expectedFillCents: offer.expectedFillFor(affordable),
    });
  }

  const strikesOf = (code: WarningCode) => skipped.get(code) ?? [];
  const list = (strikes: number[]) => strikes.map(formatPrice).join(", ");
  if (strikesOf("market_not_open").length > 0) {
    warn(
      ctx,
      "market_not_open",
      `Skipped strikes whose market is not open for taking: ${list(strikesOf("market_not_open"))}.`,
      strikesOf("market_not_open"),
    );
  }
  if (strikesOf("no_price").length > 0) {
    warn(
      ctx,
      "no_price",
      `Skipped strikes with no NO offer: ${list(strikesOf("no_price"))}.`,
      strikesOf("no_price"),
    );
  }
  if (strikesOf("below_minimum").length > 0) {
    warn(
      ctx,
      "below_minimum",
      `The holding is too small to need the 0.01-contract minimum at ${list(strikesOf("below_minimum"))}.`,
      strikesOf("below_minimum"),
    );
  }
  if (thin.length > 0) {
    const where = slippage === 0 ? "at the best price" : `within ${formatCents(slippage)} of the best price`;
    // The first sentence is the one plans always gave; `finalize` adds what more slippage would buy.
    ctx.thinDepth = warn(
      ctx,
      "thin_depth",
      `The order book is too thin at ${thin.join(", ")} contracts ${where}.`,
      strikesOf("thin_depth"),
    );
  }
  if (strikesOf("trade_cap_too_small").length > 0) {
    warn(
      ctx,
      "trade_cap_too_small",
      `The per-trade limit of ${formatUsd(input.limits.maxTradeCents)} is too small to buy even 0.01 contracts at ${list(strikesOf("trade_cap_too_small"))}.`,
      strikesOf("trade_cap_too_small"),
    );
  }
  if (capped.length > 0) {
    const what = budgetIsTighter
      ? `the remaining policy budget of ${formatUsd(input.limits.remainingBudgetCents)}`
      : `the cost cap of ${formatUsd(input.maxCostCents)}`;
    const kept =
      signal === null ? "rungs nearest spot were kept" : "the rungs the paid signal rates cheapest were kept";
    warn(
      ctx,
      capCode,
      `To stay within ${what}, ${kept} and the rest cut: ${capped.join("; ")}.`,
      strikesOf(capCode),
    );
  }
  if (signal !== null) {
    // Report rungs in staircase order, highest strike first, whatever order they were bought in.
    ctx.rungs.sort((a, b) => b.strikeCents - a.strikeCents);
    const expensive = ctx.rungs
      .filter((r) => ratingOf.get(r.instrumentSymbol)?.rating === "expensive")
      .map((r) => r.strikeCents);
    if (expensive.length > 0) {
      warn(
        ctx,
        "signal_expensive",
        `The paid signal rates protection at ${list(expensive)} as expensive (at least ${formatBand(signal.fairBandBps)} a contract above its model value); the plan still buys it because it is part of the protection asked for.`,
        expensive,
      );
    }
  }
  if (split.length > 0) {
    warn(
      ctx,
      "orders_split",
      `Rungs at ${list(split)} cost more than the ${formatUsd(input.limits.maxTradeCents)} per-trade limit, so each is split into several orders within it.`,
      split,
    );
  }
}

/**
 * Greedy split: full orders of `perOrderMax`, then the remainder. Unlike an even split, its
 * total cost never decreases as the quantity grows, which `maxAffordable` relies on.
 */
function splitOrder(hundredths: number, perOrderMax: number): number[] {
  const sizes: number[] = [];
  let left = hundredths;
  while (left > 0) {
    const size = Math.min(perOrderMax, left);
    sizes.push(size);
    left -= size;
  }
  return sizes;
}

function splitCost(hundredths: number, priceCents: number, perOrderMax: number): number {
  const full = Math.floor(hundredths / perOrderMax);
  return (
    full * orderAmountCents(perOrderMax, priceCents) + orderAmountCents(hundredths % perOrderMax, priceCents)
  );
}

/**
 * Largest quantity up to `want` whose split orders cost at most `budgetCents`, each quantity at its own
 * limit (`offer.limitFor`). The cost never decreases as the quantity grows: a larger quantity takes the
 * same levels or deeper ones, so its limit is the same or higher and its orders smaller or as large.
 */
function maxAffordable(
  want: number,
  offer: RungOffer,
  perOrderMaxAt: (priceCents: number) => number,
  budgetCents: number,
): number {
  const cost = (hundredths: number) => {
    const priceCents = offer.limitFor(hundredths);
    return splitCost(hundredths, priceCents, perOrderMaxAt(priceCents));
  };
  if (budgetCents <= 0) return 0;
  if (cost(want) <= budgetCents) return want;
  let low = 0;
  let high = want;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cost(mid) <= budgetCents) low = mid;
    else high = mid - 1;
  }
  return low;
}

function warn(ctx: Context, code: WarningCode, message: string, strikesCents: number[] = []): PlanWarning {
  const warning = { code, message, strikesCents };
  ctx.warnings.push(warning);
  return warning;
}

/** Hedge payout in cents for a final price: every NO whose strike is above the price pays $1. */
export function hedgePayoutCents(
  rungs: readonly Pick<PlannedRung, "strikeCents" | "quantityHundredths">[],
  priceCents: number,
): number {
  let payout = 0;
  for (const rung of rungs) if (priceCents < rung.strikeCents) payout += rung.quantityHundredths;
  return payout;
}

function finalize(ctx: Context): HedgePlan {
  const { ladder } = ctx.input;
  const rungs = ctx.rungs;
  const orders = rungs.flatMap((r) => r.orders);
  const costCents = orders.reduce((sum, o) => sum + o.amountCents, 0);
  const maxPayoutCents = rungs.reduce((sum, r) => sum + r.payoutCents, 0);
  const { spotCents, units, ceilingCents, floorCents } = ctx;

  const lossAtFloorCents =
    floorCents === null || floorCents >= spotCents ? null : holdingCents(units, spotCents - floorCents);
  const payoutBelowFloorCents = floorCents === null ? 0 : hedgePayoutCents(rungs, floorCents - 1);
  const coverageAtFloorBps =
    lossAtFloorCents === null || lossAtFloorCents <= 0
      ? null
      : Math.floor((payoutBelowFloorCents * 10_000) / lossAtFloorCents);

  const top = rungs[0];
  const bottom = rungs.at(-1);
  const protectedRange =
    top === undefined || bottom === undefined
      ? null
      : {
          fromCents: Math.max(...rungs.map((r) => r.coversFromCents)),
          toCents: Math.min(...rungs.map((r) => r.coversToCents)),
        };

  const payoff = payoffCurve(ctx, costCents);
  const breakEven = breakEvenNotes(ctx, costCents, payoff);
  const holdingQuantity = formatHoldingUnits(units);
  const fullyCovered =
    ctx.uncovered.length === 0 && !ctx.warnings.some((w) => w.code === "category_not_allowed");
  const status = orders.length === 0 ? "empty" : fullyCovered ? "ok" : "partial";

  const canonical = JSON.stringify({
    asset: ctx.asset,
    eventTicker: ladder.eventTicker,
    expiry: ladder.expiry,
    spotCents,
    holdingQuantity,
    ceilingCents,
    floorCents,
    orders: orders.map((o) => [o.instrumentSymbol, o.quantityHundredths, o.limitPriceCents]),
    // Only plans given a signal carry this key, so every plan id without one is unchanged.
    ...(ctx.signal === null ? {} : { signal: [ctx.signal.paid.receiptId, ctx.signal.paid.signal.signalId] }),
    // The same for positions held: a top-up made against other positions is another plan.
    ...(ctx.input.held === undefined || ctx.input.held.length === 0 ? {} : { held: heldKey(ctx.input.held) }),
  });
  const signal = ctx.signal === null ? null : signalUse(ctx, ctx.signal, orders);
  const cover = ctx.cover === null ? null : planCover(ctx.cover, rungs);
  const expectedFillCents = rungs.reduce((sum, r) => sum + (r.expectedFillCents ?? r.amountCents), 0);
  const depth =
    ctx.withOptions && ctx.thinDepth !== null
      ? measureDepthOptions(ctx, ctx.thinDepth, coverBpsOf(cover, coverageAtFloorBps))
      : null;

  return {
    planId: planIdFor(canonical),
    status,
    asset: ctx.asset,
    eventTicker: ladder.eventTicker,
    expiry: ladder.expiry,
    spotCents,
    holdingQuantity,
    ceilingCents,
    floorCents,
    rungs,
    orders,
    totals: {
      costCents,
      maxPayoutCents,
      contractsHundredths: maxPayoutCents,
      orderCount: orders.length,
      spendCapCents: ctx.spendCapCents,
      protectedRange,
      lossAtFloorCents,
      payoutBelowFloorCents,
      coverageAtFloorBps,
      expectedFillCents,
    },
    payoff,
    breakEven,
    warnings: ctx.warnings,
    uncovered: ctx.uncovered,
    ...(signal === null ? {} : { signal }),
    ...(cover === null ? {} : { cover }),
    ...(depth === null ? {} : depth),
  };
}

/** The cover a plan gives: with positions held, theirs and the plan's together; otherwise at the floor. */
function coverBpsOf(cover: PlanCover | null | undefined, coverageAtFloorBps: number | null): number | null {
  return cover === null || cover === undefined ? coverageAtFloorBps : cover.withPlanCoverBps;
}

/** Why a plan leaves part of the goal out that more slippage can change: depth, or the money it may spend. */
const SHORT_CODES: readonly WarningCode[] = ["thin_depth", "cost_cap_reached", "budget_exhausted"];

/**
 * What the same plan would be at each higher slippage, up to `MAX_SLIPPAGE_CENTS`: the planner run again
 * with only `slippageCents` changed, so every option respects the spending cap, the budget, the per-trade
 * limit and the depth exactly as a plan made at that slippage would. Only slippages that buy a different
 * quantity than the one before are kept. The `thin_depth` warning then says what they buy.
 */
function measureDepthOptions(
  ctx: Context,
  thin: PlanWarning,
  coverBps: number | null,
): { depthOptions: DepthOption[]; coversAtSlippageCents: number | null } {
  const slippage = ctx.input.slippageCents ?? 0;
  // A step counts when it buys a different quantity somewhere: a limit that moves alone buys nothing more.
  const key = (rungs: readonly PlannedRung[]) =>
    JSON.stringify(rungs.map((r) => [r.instrumentSymbol, r.quantityHundredths]));
  let previous = key(ctx.rungs);
  const depthOptions: DepthOption[] = [];
  for (let slippageCents = slippage + 1; slippageCents <= MAX_SLIPPAGE_CENTS; slippageCents++) {
    const option = plan({ ...ctx.input, slippageCents }, false);
    const current = key(option.rungs);
    if (current === previous) continue;
    previous = current;
    const short = option.uncovered.filter((slice) => SHORT_CODES.includes(slice.code));
    depthOptions.push({
      slippageCents,
      coverBps: coverBpsOf(option.cover, option.totals.coverageAtFloorBps),
      totalAmountCents: option.totals.costCents,
      expectedFillCents: option.totals.expectedFillCents ?? option.totals.costCents,
      orderCount: option.orders.length,
      orderAmountsCents: option.orders.map((o) => o.amountCents),
      shortStrikesCents: [...new Set(short.flatMap((slice) => slice.strikeCents ?? []))],
      coversGoal: short.length === 0,
    });
  }
  const covers = depthOptions.find((option) => option.coversGoal) ?? null;
  const coversAtSlippageCents = covers?.slippageCents ?? null;

  const at = (cents: number) =>
    cents === 0 ? "At the best price" : `Paying up to ${formatCents(cents)} above the best price`;
  const percent = (bps: number | null) => (bps === null ? "none of the goal" : formatBps(bps));
  const cost = (option: DepthOption) =>
    `${formatUsd(option.totalAmountCents)} committed (about ${formatUsd(option.expectedFillCents)} expected)`;
  const most = depthOptions.reduce<DepthOption | null>(
    (best, option) => (best === null || (option.coverBps ?? 0) > (best.coverBps ?? 0) ? option : best),
    null,
  );
  const walkable = ctx.input.ladder.rungs.some(
    (rung) =>
      thin.strikesCents.includes(rung.strikeCents) &&
      rung.depth?.noOffers !== undefined &&
      ctx.input.depthHundredths?.[rung.instrumentSymbol] === undefined,
  );
  let more: string | null = null;
  if (covers !== null) {
    more = `${at(covers.slippageCents)} covers ${percent(covers.coverBps)}, for ${cost(covers)}.`;
  } else if (most !== null) {
    more = `${at(most.slippageCents)} covers ${percent(most.coverBps)}, for ${cost(most)}; no slippage up to ${formatCents(MAX_SLIPPAGE_CENTS)} covers the goal within the spending cap.`;
  } else if (walkable && slippage < MAX_SLIPPAGE_CENTS) {
    more = `No more is offered within ${formatCents(MAX_SLIPPAGE_CENTS)} of the best price.`;
  }
  if (more !== null)
    thin.message = `${thin.message} ${at(slippage)} this plan covers ${percent(coverBps)}. ${more}`;
  return { depthOptions, coversAtSlippageCents };
}

/** "1 cent", "5 cents". */
function formatCents(cents: number): string {
  return cents === 1 ? "1 cent" : `${cents.toString()} cents`;
}

/** Contracts held per symbol, sorted, for the plan id. */
function heldKey(held: NonNullable<HedgeInput["held"]>): [string, number][] {
  const totals = new Map<string, number>();
  for (const p of held) totals.set(p.instrumentSymbol, (totals.get(p.instrumentSymbol) ?? 0) + p.hundredths);
  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The cover the plan was made against, plus what it pays once the plan's orders are held too. */
function planCover(cover: CoverAssessment, rungs: readonly PlannedRung[]): PlanCover {
  const below = cover.measuredBelowCents;
  const added = below === null ? 0 : hedgePayoutCents(rungs, below - 1);
  const withPlanPayoutCents = cover.heldPayoutCents + added;
  return {
    ...cover,
    withPlanPayoutCents,
    withPlanCoverBps:
      cover.targetPayoutCents === 0
        ? null
        : Math.floor((withPlanPayoutCents * 10_000) / cover.targetPayoutCents),
  };
}

function signalUse(ctx: Context, signal: SignalContext, orders: readonly PlannedOrder[]): PlanSignalUse {
  const used = signal.ignoredBecause === null;
  const bought = new Map(ctx.rungs.map((r) => [r.instrumentSymbol, r.quantityHundredths]));
  const rungs = ctx.ratings.map((rating) => ({
    ...rating,
    boughtHundredths: bought.get(rating.instrumentSymbol) ?? 0,
  }));
  // The same inputs without the signal: the plan says plainly whether the signal changed anything.
  const baseline = used ? plan({ ...ctx.input, signal: undefined }, false).orders : orders;
  const key = (list: readonly PlannedOrder[]) =>
    JSON.stringify(list.map((o) => [o.instrumentSymbol, o.quantityHundredths, o.limitPriceCents]));
  return {
    receiptId: signal.paid.receiptId,
    signalId: signal.paid.signal.signalId,
    used,
    ignoredBecause: signal.ignoredBecause,
    buyOrder: used ? "signal" : "nearest_spot",
    changedOrders: key(baseline) !== key(orders),
    rungs,
    expensiveBoughtStrikesCents: rungs
      .filter((r) => r.rating === "expensive" && r.boughtHundredths > 0)
      .map((r) => r.strikeCents),
  };
}

/** "2 cents", "1 cent", "1.50 cents" from basis points of a dollar. */
function formatBand(bps: number): string {
  if (bps === 100) return "1 cent";
  if (bps % 100 === 0) return `${(bps / 100).toString()} cents`;
  return `${Math.floor(bps / 100).toString()}.${(bps % 100).toString().padStart(2, "0")} cents`;
}

/**
 * Payoff at a sensible set of final prices: both ends of the range, spot, ceiling, floor, and
 * for every rung its strike (where NO does not pay yet) and one cent below it (where it does),
 * plus an even grid for charting.
 */
function payoffCurve(ctx: Context, costCents: number): PayoffPoint[] {
  const { spotCents, units, rungs } = ctx;
  const ceiling = ctx.ceilingCents ?? spotCents;
  const floor = ctx.floorCents ?? Math.floor((spotCents * 95) / 100);
  const lowestStrike = Math.min(floor, ...rungs.map((r) => r.strikeCents));
  const highest = Math.max(spotCents, ceiling);
  const margin = Math.max(Math.ceil((highest - lowestStrike) / 4), Math.ceil(spotCents / 100));
  const low = Math.max(0, lowestStrike - margin);
  const high = highest + margin;
  const prices = new Set<number>([low, high, spotCents, ceiling, floor]);
  for (const rung of rungs) {
    prices.add(rung.strikeCents);
    prices.add(rung.strikeCents - 1);
  }
  const steps = 24;
  for (let i = 1; i < steps; i++) prices.add(low + Math.round(((high - low) * i) / steps));
  return [...prices]
    .filter((p) => p >= low && p <= high)
    .sort((a, b) => a - b)
    .map((priceCents) => {
      const unhedgedPnlCents = holdingCents(units, priceCents - spotCents);
      const hedgePnlCents = hedgePayoutCents(rungs, priceCents) - costCents;
      return { priceCents, unhedgedPnlCents, hedgePnlCents, netPnlCents: unhedgedPnlCents + hedgePnlCents };
    });
}

function breakEvenNotes(ctx: Context, costCents: number, payoff: PayoffPoint[]): HedgePlan["breakEven"] {
  const { rungs, asset, spotCents, units } = ctx;
  if (rungs.length === 0 || costCents === 0) {
    return { paysForItselfBelowCents: null, netBreakEvenAboveCents: null, notes: [] };
  }
  let cumulative = 0;
  let paysForItselfBelowCents: number | null = null;
  for (const rung of rungs) {
    cumulative += rung.payoutCents;
    if (cumulative >= costCents) {
      paysForItselfBelowCents = rung.strikeCents;
      break;
    }
  }
  // Above spot the hedge pays nothing (every rung is at or below spot unless the ceiling was
  // raised a step), so net break-even is where the holding's gain equals the cost.
  const netBreakEvenAboveCents = spotCents + Number(ceilDiv(BigInt(costCents) * HOLDING_SCALE, units));
  const topStrike = Math.max(...rungs.map((r) => r.strikeCents));
  const notes: string[] = [];
  notes.push(
    paysForItselfBelowCents === null
      ? `The hedge costs ${formatUsd(costCents)} and never pays back more than that.`
      : `The hedge costs ${formatUsd(costCents)} and pays back at least that if ${asset} finishes below ${formatPrice(paysForItselfBelowCents)}.`,
  );
  notes.push(
    `At or above ${formatPrice(topStrike)} every NO contract expires worthless; ${asset} must finish above ${formatPrice(netBreakEvenAboveCents)} for the holding's gain to cover the cost.`,
  );
  const ceiling = ctx.ceilingCents;
  const floor = ctx.floorCents;
  if (ceiling !== null && floor !== null) {
    const top = Math.min(ceiling, spotCents);
    const inRange = payoff.filter((p) => p.priceCents >= floor && p.priceCents <= top);
    const worst = inRange.reduce<PayoffPoint | null>(
      (min, p) => (min === null || p.netPnlCents < min.netPnlCents ? p : min),
      null,
    );
    if (worst !== null && worst.netPnlCents < 0) {
      notes.push(
        `Between ${formatPrice(floor)} and ${formatPrice(ceiling)} the worst net result is a loss of ${formatUsd(-worst.netPnlCents)}, at ${formatPrice(worst.priceCents)}, against ${formatUsd(-holdingCents(units, worst.priceCents - spotCents))} unhedged.`,
      );
    }
  }
  return { paysForItselfBelowCents, netBreakEvenAboveCents, notes };
}
