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
import { planIdFor } from "./id";
import type {
  HedgeInput,
  HedgePlan,
  PayoffPoint,
  PlannedOrder,
  PlannedRung,
  PlanWarning,
  UncoveredSlice,
  WarningCode,
} from "./types";
import {
  ceilDiv,
  floorDiv,
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

interface DesignedRung {
  rung: LadderRung;
  coversFromCents: number;
  coversToCents: number;
  designedHundredths: number;
}

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
}

export function planHedge(input: HedgeInput): HedgePlan {
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
  };

  if (!input.limits.categoryAllowed) {
    warn(
      ctx,
      "category_not_allowed",
      "The policy does not allow trading this market category, so no hedge is planned.",
    );
    return finalize(ctx);
  }

  const ascending = [...input.ladder.rungs].sort((a, b) => a.strikeCents - b.strikeCents);
  const descending = [...ascending].reverse();
  const floorCents = resolveFloor(input, spotCents);
  const ceilingCents = resolveCeiling(ctx, ascending, descending);
  if (ceilingCents === null) return finalize(ctx);
  ctx.ceilingCents = ceilingCents;
  ctx.floorCents = floorCents;
  if (floorCents >= ceilingCents) {
    warn(
      ctx,
      "floor_not_below_ceiling",
      `The floor ${formatPrice(floorCents)} is not below where protection starts (${formatPrice(ceilingCents)}), so there is nothing to protect.`,
    );
    return finalize(ctx);
  }

  const designed = design(ctx, descending, ceilingCents, floorCents);
  buy(ctx, designed, slippage);
  return finalize(ctx);
}

function resolveFloor(input: HedgeInput, spotCents: number): number {
  const goal = input.goal;
  if ("floorCents" in goal) {
    requireInteger(goal.floorCents, "goal.floorCents", 1);
    return goal.floorCents;
  }
  const bps = Math.round(goal.dropPercent * 100);
  if (
    !Number.isFinite(goal.dropPercent) ||
    bps <= 0 ||
    bps >= 10_000 ||
    Math.abs(goal.dropPercent * 100 - bps) > 1e-6
  ) {
    throw new PlannerInputError("goal.dropPercent must be between 0 and 100 with at most two decimals");
  }
  // spot x (1 - drop), rounded half up to the cent.
  return Number(floorDiv(BigInt(spotCents) * BigInt(10_000 - bps) + 5_000n, 10_000n));
}

function resolveCeiling(ctx: Context, ascending: LadderRung[], descending: LadderRung[]): number | null {
  const { spotCents } = ctx;
  const requested = ctx.input.goal.ceilingCents;
  const firstAtOrAbove = ascending.find((r) => r.strikeCents >= spotCents)?.strikeCents;
  const highestAllowed = firstAtOrAbove ?? spotCents;
  let ceiling: number;
  if (requested === undefined) {
    if (!descending.some((r) => r.strikeCents < spotCents)) {
      warn(
        ctx,
        "no_strike_below_spot",
        `Every strike on this ladder is at or above spot (${formatPrice(spotCents)}), so it cannot protect against a fall.`,
      );
      return null;
    }
    // Protect the holding's actual loss: the top rung is the highest strike below spot, sized
    // for the drop from spot to that strike.
    ceiling = spotCents;
  } else {
    requireInteger(requested, "goal.ceilingCents", 1);
    ceiling = requested;
    if (ceiling > highestAllowed) {
      warn(
        ctx,
        "ceiling_lowered",
        `Protection cannot start at ${formatPrice(requested)}, more than one strike above spot; it starts at ${formatPrice(highestAllowed)} instead.`,
      );
      ceiling = highestAllowed;
    }
  }
  if (ceiling > spotCents) {
    const excess = holdingCents(ctx.units, ceiling - spotCents);
    warn(
      ctx,
      "ceiling_above_spot",
      `Protection starts at ${formatPrice(ceiling)}, above spot (${formatPrice(spotCents)}), so the payout can exceed the holding's actual loss by up to ${formatUsd(excess)}.`,
    );
  }
  return ceiling;
}

function design(
  ctx: Context,
  descending: LadderRung[],
  ceilingCents: number,
  floorCents: number,
): DesignedRung[] {
  const designed: DesignedRung[] = [];
  let previous = ceilingCents;
  for (const rung of descending) {
    if (rung.strikeCents >= ceilingCents) continue;
    const bottom = Math.max(rung.strikeCents, floorCents);
    const gap = previous - bottom;
    if (gap <= 0) break;
    designed.push({
      rung,
      coversFromCents: previous,
      coversToCents: bottom,
      // q x gap dollars, in hundredths of a contract: units x gapCents / 1e8, rounded down.
      designedHundredths: Number(floorDiv(ctx.units * BigInt(gap), HOLDING_SCALE)),
    });
    previous = rung.strikeCents;
    if (rung.strikeCents <= floorCents) break;
  }
  if (previous > floorCents) {
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

function buy(ctx: Context, designed: DesignedRung[], slippage: number): void {
  const { input } = ctx;
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
    let want = d.designedHundredths;
    if (want < 1) {
      note("below_minimum", d, 0);
      continue;
    }
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
    const limitPriceCents = Math.min(99, rung.noBuyCents + slippage);
    const depth = input.depthHundredths?.[rung.instrumentSymbol] ?? rung.depth?.noBuyHundredths;
    if (depth !== undefined && depth < want) {
      thin.push(`${formatPrice(rung.strikeCents)} (${formatContracts(depth)} of ${formatContracts(want)})`);
      note("thin_depth", d, want - depth);
      want = depth;
      if (want < 1) continue;
    }
    const perOrderMax = Math.floor((input.limits.maxTradeCents * 100) / limitPriceCents);
    if (perOrderMax < 1) {
      note("trade_cap_too_small", d, want);
      continue;
    }
    const affordable = maxAffordable(want, limitPriceCents, perOrderMax, ctx.spendCapCents - spent);
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
    warn(
      ctx,
      "thin_depth",
      `The order book is too thin at ${thin.join(", ")} contracts at the best price.`,
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
    warn(
      ctx,
      capCode,
      `To stay within ${what}, rungs nearest spot were kept and the rest cut: ${capped.join("; ")}.`,
      strikesOf(capCode),
    );
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

/** Largest quantity up to `want` whose split orders cost at most `budgetCents`. */
function maxAffordable(want: number, priceCents: number, perOrderMax: number, budgetCents: number): number {
  if (budgetCents <= 0) return 0;
  if (splitCost(want, priceCents, perOrderMax) <= budgetCents) return want;
  let low = 0;
  let high = want;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (splitCost(mid, priceCents, perOrderMax) <= budgetCents) low = mid;
    else high = mid - 1;
  }
  return low;
}

function warn(ctx: Context, code: WarningCode, message: string, strikesCents: number[] = []): void {
  ctx.warnings.push({ code, message, strikesCents });
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
  });

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
    },
    payoff,
    breakEven,
    warnings: ctx.warnings,
    uncovered: ctx.uncovered,
  };
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
