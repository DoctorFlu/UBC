/**
 * Cover: whether the NO contracts already held on a ladder protect a holding as a goal asks, and what
 * is missing. It is computed from positions the contract and executor record, never from a model's
 * reading of raw tool output, so every run, the agent and the console get the same answer.
 * `docs/cover.md` states the definition in plain words.
 *
 * The goal's staircase (`designStaircase`) calls for n_i contracts at strike K_i, highest first, and
 * pays T = sum(n_i) once the price is below the last strike, which is the floor F when F is a strike.
 * A NO contract at strike S pays $1 whenever the price ends below S, so the positions held pay
 *
 *     E(K) = sum of contracts held at strikes S >= K      for a finish just below K.
 *
 * Cover is measured at the bottom of the staircase, K_last: the goal is met when E(K_last) is at least
 * T minus a tolerance. When it is not, the missing contracts per rung are the smallest top-up that
 * brings the cumulative payout up to the staircase at every rung, nearest spot first, and never adds
 * more below the floor than the shortfall there:
 *
 *     B_i = min(T - E(K_last), max(B_{i-1}, T_i - E(K_i))),   missing_i = B_i - B_{i-1},
 *
 * where T_i is the staircase's payout just below K_i. With nothing held this is the full staircase;
 * with the whole staircase held it is nothing.
 */
import { eventTickerCandidates, type Ladder } from "@mandate/gemini";
import {
  designStaircase,
  resolveCeiling,
  resolveFloor,
  type DesignedRung,
  type StrikeRung,
} from "./staircase";
import type {
  CoverAssessment,
  CoverRung,
  HeldPosition,
  Holding,
  PositionState,
  ProtectionGoal,
} from "./types";
import { formatHoldingUnits, parseHoldingUnits, PlannerInputError, requireInteger } from "./units";

/**
 * A shortfall of up to 2 % of the target payout (rounded down to the cent) still counts as covered. It
 * absorbs the 0.01-contract rounding of each rung and small moves of spot between runs (the goal is
 * measured from spot), so a holding covered 99 % is never bought a second time for a few cents of drift.
 */
export const COVER_TOLERANCE_BPS = 200;

/** The ladder a goal is measured on: its strikes, and its spot when `spotCents` is not given. */
export interface CoverLadder {
  asset: string;
  eventTicker: string;
  rungs: readonly StrikeRung[];
  spot?: Pick<Ladder["spot"], "midCents">;
}

export interface CoverInput {
  holding: Holding;
  ladder: CoverLadder;
  /** Spot the goal is measured from. Default: `ladder.spot.midCents`. */
  spotCents?: number;
  goal: ProtectionGoal;
  held: readonly HeldPosition[];
}

/**
 * An intent as the Policy contract records it, in the fields cover needs. `IntentView` and `Intent`
 * from `@mandate/shared` both fit; the planner takes no type from it, only its date formatter.
 */
export interface RecordedIntent {
  id: number;
  market: string | null;
  outcome: string | null;
  isBuy: boolean | null;
  amountCents: number | null;
  limitPrice: number | null;
  status: string;
  filledCents: number | null;
}

/** A held position and the intent that holds it. */
export interface IntentPosition extends HeldPosition {
  intentId: number;
}

/**
 * A position on this ladder whose strike neither the ladder nor `elsewhere` gives. Cover cannot be
 * measured without it: a caller that counted cover without the position could buy the same protection
 * twice, so it refuses instead (the agent plans nothing, the console shows cover as unavailable).
 */
export class UnresolvedPositionError extends Error {
  override readonly name = "UnresolvedPositionError";
  constructor(readonly instrumentSymbols: readonly string[]) {
    super(
      `${instrumentSymbols.join(", ")} ${instrumentSymbols.length === 1 ? "is" : "are"} held on this ladder, but ` +
        "neither the venue nor Gemini's production exchange lists the strike now, so cover cannot be measured.",
    );
  }
}

/** Whether an instrument symbol belongs to the event `eventTicker` (`GEMI-<event ticker>-<contract>`). */
function onEvent(instrumentSymbol: string, eventTicker: string): boolean {
  return eventTickerCandidates(instrumentSymbol).includes(eventTicker);
}

/** The intents that count as cover, with the cents they count for, before their strikes are known. */
function counted(
  intents: Iterable<RecordedIntent>,
): { intent: RecordedIntent; market: string; cents: number; price: number; state: PositionState }[] {
  const out: {
    intent: RecordedIntent;
    market: string;
    cents: number;
    price: number;
    state: PositionState;
  }[] = [];
  for (const intent of intents) {
    if (intent.market === null || intent.outcome !== "NO" || intent.isBuy !== true) continue;
    const price = intent.limitPrice;
    if (price === null || price < 1 || price > 99) continue;
    let state: PositionState;
    let cents: number | null;
    if (intent.status === "executed") {
      state = "filled";
      cents = intent.filledCents;
    } else if (intent.status === "approved") {
      state = "awaiting_fill";
      cents = intent.amountCents;
    } else if (intent.status === "needs_approval") {
      state = "awaiting_owner";
      cents = intent.amountCents;
    } else {
      continue;
    }
    if (cents === null || !Number.isSafeInteger(cents) || cents <= 0) continue;
    if (Math.floor((cents * 100) / price) < 1) continue;
    out.push({ intent, market: intent.market, cents, price, state });
  }
  return out;
}

/**
 * The symbols of positions on this ladder's event that the ladder does not list: positions filled where
 * the ladder was not read, such as the simulated venue's fills (listed on Gemini's production exchange)
 * on a stack that now reads the sandbox. A strike belongs to its symbol on every exchange, so the caller
 * looks these up on production and passes them to `positionsFromIntents` as `elsewhere`. Empty when the
 * ladder lists every one, which is the usual case: then nothing more is read.
 */
export function symbolsMissingFromLadder(
  intents: Iterable<RecordedIntent>,
  ladder: Pick<CoverLadder, "eventTicker" | "rungs">,
): string[] {
  const listed = new Set(ladder.rungs.map((r) => r.instrumentSymbol));
  const missing = new Set<string>();
  for (const { market } of counted(intents)) {
    if (!listed.has(market) && onEvent(market, ladder.eventTicker)) missing.add(market);
  }
  return [...missing].sort();
}

/**
 * The NO buys on this ladder that still count, one position per intent:
 * - executed: the contracts its recorded fill buys at its limit price,
 * - approved and waiting for the executor, or waiting for the owner: the contracts its amount buys at
 *   its limit price,
 * - rejected, failed, sells, YES, other ladders and numbers that do not fit: nothing.
 *
 * A position's strike comes from the ladder, or for a symbol the ladder does not list, from `elsewhere`
 * (strikes Gemini's production exchange lists on the same event, `symbolsMissingFromLadder`). A position
 * on this event whose strike neither gives throws `UnresolvedPositionError`: it is never dropped quietly.
 *
 * Contracts are `floor(cents x 100 / limitPrice)` hundredths: the most the money buys at the limit, in
 * Gemini's 0.01-contract increments. For an order the planner sized, that is at least the planned
 * quantity, so a plan executed in full always reads as at least the cover it planned.
 */
export function positionsFromIntents(
  intents: Iterable<RecordedIntent>,
  ladder: Pick<CoverLadder, "eventTicker" | "rungs">,
  elsewhere: ReadonlyMap<string, number> = new Map(),
): IntentPosition[] {
  const strikeOf = new Map(ladder.rungs.map((r) => [r.instrumentSymbol, r.strikeCents]));
  const positions: IntentPosition[] = [];
  const unresolved = new Set<string>();
  for (const { intent, market, cents, price, state } of counted(intents)) {
    const strikeCents =
      strikeOf.get(market) ?? (onEvent(market, ladder.eventTicker) ? elsewhere.get(market) : undefined);
    if (strikeCents === undefined) {
      if (onEvent(market, ladder.eventTicker)) unresolved.add(market);
      continue;
    }
    const hundredths = Math.floor((cents * 100) / price);
    positions.push({ intentId: intent.id, instrumentSymbol: market, strikeCents, hundredths, state });
  }
  if (unresolved.size > 0) throw new UnresolvedPositionError([...unresolved].sort());
  return positions;
}

/** Validated positions: whole hundredths, at least zero. Throws on anything else. */
function checkHeld(held: readonly HeldPosition[]): void {
  held.forEach((p, i) => {
    requireInteger(p.hundredths, `held[${i.toString()}].hundredths`);
    requireInteger(p.strikeCents, `held[${i.toString()}].strikeCents`, 1);
  });
}

/** E(K): what the positions pay for a finish just below `strikeCents`. */
function heldPayoutBelow(held: readonly HeldPosition[], strikeCents: number): number {
  let payout = 0;
  for (const p of held) if (p.strikeCents >= strikeCents) payout += p.hundredths;
  return payout;
}

function emptyByState(): Record<PositionState, number> {
  return { filled: 0, awaiting_fill: 0, awaiting_owner: 0 };
}

/**
 * The cover of a staircase already designed. `planHedge` calls this with its own staircase, so a plan
 * and an assessment of the same goal can never disagree.
 */
export function measureCover(args: {
  asset: string;
  eventTicker: string;
  spotCents: number;
  units: bigint;
  ceilingCents: number | null;
  floorCents: number | null;
  designed: readonly DesignedRung<StrikeRung>[];
  held: readonly HeldPosition[];
}): CoverAssessment {
  checkHeld(args.held);
  const { designed, held } = args;
  const base = {
    asset: args.asset,
    eventTicker: args.eventTicker,
    spotCents: args.spotCents,
    holdingQuantity: formatHoldingUnits(args.units),
    ceilingCents: args.ceilingCents,
    floorCents: args.floorCents,
  };
  const target = designed.reduce((sum, d) => sum + d.designedHundredths, 0);
  const bottom = designed.at(-1)?.rung.strikeCents;
  if (bottom === undefined || target === 0) {
    return {
      ...base,
      state: "nothing_to_cover",
      measuredBelowCents: null,
      targetPayoutCents: 0,
      heldPayoutCents: 0,
      heldByState: emptyByState(),
      shortfallCents: 0,
      toleranceCents: 0,
      coverBps: null,
      missingPayoutCents: 0,
      rungs: [],
    };
  }

  const heldPayout = heldPayoutBelow(held, bottom);
  const heldByState = emptyByState();
  for (const p of held) if (p.strikeCents >= bottom) heldByState[p.state] += p.hundredths;
  const shortfall = Math.max(0, target - heldPayout);
  // Rounded down, so a target under 50 cents has no tolerance and nothing held is never "met".
  const tolerance = Math.floor((target * COVER_TOLERANCE_BPS) / 10_000);
  const met = shortfall <= tolerance;

  const heldAt = new Map<string, number>();
  for (const p of held) heldAt.set(p.instrumentSymbol, (heldAt.get(p.instrumentSymbol) ?? 0) + p.hundredths);
  let cumulativeTarget = 0;
  let bought = 0;
  const rungs: CoverRung[] = designed.map((d) => {
    cumulativeTarget += d.designedHundredths;
    let missing = 0;
    if (!met) {
      const deficit = cumulativeTarget - heldPayoutBelow(held, d.rung.strikeCents);
      const next = Math.min(shortfall, Math.max(bought, deficit));
      missing = next - bought;
      bought = next;
    }
    return {
      instrumentSymbol: d.rung.instrumentSymbol,
      strikeCents: d.rung.strikeCents,
      targetHundredths: d.designedHundredths,
      heldHundredths: heldAt.get(d.rung.instrumentSymbol) ?? 0,
      missingHundredths: missing,
    };
  });

  return {
    ...base,
    state: met ? "met" : heldPayout === 0 ? "not_met" : "partly_met",
    measuredBelowCents: bottom,
    targetPayoutCents: target,
    heldPayoutCents: heldPayout,
    heldByState,
    shortfallCents: shortfall,
    toleranceCents: tolerance,
    coverBps: Math.floor((heldPayout * 10_000) / target),
    missingPayoutCents: bought,
    rungs,
  };
}

/**
 * Whether the positions held cover a protection goal on this ladder. The goal means exactly what it
 * means to `planHedge`: same floor, same ceiling (default spot), same staircase.
 */
export function assessCover(input: CoverInput): CoverAssessment {
  const units = parseHoldingUnits(input.holding.quantity);
  const asset = input.holding.asset.trim().toUpperCase();
  if (input.ladder.asset.toUpperCase() !== asset) {
    throw new PlannerInputError(`The ladder is for ${input.ladder.asset}, but the holding is ${asset}`);
  }
  const spotCents = input.spotCents ?? input.ladder.spot?.midCents;
  if (spotCents === undefined)
    throw new PlannerInputError("spotCents is required when the ladder has no spot");
  requireInteger(spotCents, "spotCents", 1);
  const ascending = [...input.ladder.rungs].sort((a, b) => a.strikeCents - b.strikeCents);
  const floorCents = resolveFloor(input.goal, spotCents);
  const ceilingCents = resolveCeiling(units, spotCents, input.goal.ceilingCents, ascending, () => undefined);
  const designed =
    ceilingCents === null || floorCents >= ceilingCents
      ? []
      : designStaircase(units, [...ascending].reverse(), ceilingCents, floorCents).designed;
  return measureCover({
    asset,
    eventTicker: input.ladder.eventTicker,
    spotCents,
    units,
    ceilingCents,
    floorCents: ceilingCents === null ? null : floorCents,
    designed,
    held: input.held,
  });
}

/** The goal a stored plan was made for: its holding, ladder, floor, ceiling and the spot it read. */
export interface PlanGoal {
  asset: string;
  eventTicker: string;
  floorCents: number | null;
  ceilingCents: number | null;
  spotCents: number;
  holdingQuantity: string;
}

/**
 * The cover held now against the goal of a plan (issue #97): positions from the intents on the plan's
 * ladder, the holding as saved now (or as the plan read it), today's spot, the plan's floor, and its
 * ceiling when the plan set one. A ceiling equal to the plan's spot is the default, which moves with
 * spot. The console's "Cover now" and the agent's daily digest both read it from here. Null when the
 * plan has no floor, the ladder is another one, or the planner refuses the holding.
 */
export function coverOfPlan(input: {
  plan: PlanGoal;
  /** The holding as saved now, or null to use the plan's. */
  holdingQuantity: string | null;
  ladder: Pick<CoverLadder, "asset" | "eventTicker" | "rungs">;
  spotCents: number;
  intents: Iterable<RecordedIntent>;
  /** Strikes of positions the ladder does not list, from production (`symbolsMissingFromLadder`). */
  elsewhere?: ReadonlyMap<string, number>;
}): { assessment: CoverAssessment; positions: IntentPosition[] } | null {
  const { plan, ladder } = input;
  if (plan.floorCents === null || ladder.eventTicker !== plan.eventTicker) return null;
  const goal: ProtectionGoal =
    plan.ceilingCents !== null && plan.ceilingCents !== plan.spotCents
      ? { floorCents: plan.floorCents, ceilingCents: plan.ceilingCents }
      : { floorCents: plan.floorCents };
  try {
    // A position whose strike is unknown throws here too: no cover is shown rather than a short one.
    const positions = positionsFromIntents(input.intents, ladder, input.elsewhere);
    const assessment = assessCover({
      holding: { asset: plan.asset, quantity: input.holdingQuantity ?? plan.holdingQuantity },
      ladder,
      spotCents: input.spotCents,
      goal,
      held: positions,
    });
    return { assessment, positions };
  } catch {
    // A holding or goal the planner refuses (for example a quantity edited to nonsense), or a position on
    // this ladder whose strike nobody lists, has no cover.
    return null;
  }
}
