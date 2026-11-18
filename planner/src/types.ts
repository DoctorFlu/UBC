import type { Ladder } from "@mandate/gemini";
import type { StrikeRung } from "./staircase";

/** What the owner holds. */
export interface Holding {
  asset: string;
  /** Units of the asset, up to 8 decimals, e.g. "0.05". A string keeps it exact. */
  quantity: string | number;
}

/**
 * How far down to protect. The protected loss runs from the ceiling (where protection starts)
 * down to the floor (where it stops).
 */
export type ProtectionGoal = (
  | {
      /** Protect down to this price. */
      floorCents: number;
    }
  | {
      /** Protect down to spot minus this percentage, e.g. 2.5 for a 2.5 % drop. Two decimals at most. */
      dropPercent: number;
    }
) & {
  /**
   * Where protection starts. Default: spot, so the top rung is the highest strike below spot,
   * sized for the drop from spot to it. It may be at most the first strike at or above spot
   * (the plan then says how much it can pay beyond the holding's actual loss); anything higher
   * is lowered to that strike.
   */
  ceilingCents?: number;
};

/**
 * The policy headroom the plan must fit in. Defined here rather than imported so the planner
 * stays a leaf package.
 */
export interface PolicyLimits {
  /** Largest single order. Larger rungs are split into several orders. */
  maxTradeCents: number;
  /** What the policy still allows the agent to spend. */
  remainingBudgetCents: number;
  /** Whether the policy allows trading this market category at all. */
  categoryAllowed: boolean;
}

export interface HedgeInput {
  holding: Holding;
  ladder: Ladder;
  /** Spot price the holding's profit and loss is measured from. Default: `ladder.spot.midCents`. */
  spotCents?: number;
  goal: ProtectionGoal;
  /** The most the owner wants to spend on this hedge. */
  maxCostCents: number;
  limits: PolicyLimits;
  /**
   * Contracts available at the best NO price, in hundredths, by instrument symbol. Overrides
   * any depth already on the ladder. Rungs without a depth figure are treated as unlimited.
   */
  depthHundredths?: Readonly<Record<string, number>>;
  /**
   * How many cents above each rung's NO price the plan may pay (the limit never exceeds 99). Default 0.
   * Above 0, with the book's levels on the ladder (`depth.noOffers`), it buys depth: a rung takes every
   * level priced within it, cheapest first, up to what the goal needs, and its limit is the deepest level
   * used, so an order commits no more than the book requires (no cushion for a move before placement).
   * Without the levels, or for a rung in `depthHundredths`, the limit is the NO price plus this, as before.
   */
  slippageCents?: number;
  /**
   * A paid hedge signal for this ladder. When given, the plan rates each rung's price against the
   * signal's model, buys the cheapest rungs first when the spend cap cannot cover every rung, and
   * flags expensive ones. Without it the plan is exactly what it would be otherwise.
   */
  signal?: PaidSignal | undefined;
  /**
   * Protection already held on this ladder, as the contract and executor record it. When given, the
   * plan buys only what is missing from the goal (nothing when the goal is already covered) and
   * carries a `cover` assessment. Without it the plan is the full staircase, as before.
   */
  held?: readonly HeldPosition[] | undefined;
  /**
   * Strikes Gemini's production exchange lists on this ladder's event that `ladder` does not, when the
   * orders go to another exchange. They are part of the goal (what is covered), never bought.
   */
  elsewhere?: readonly StrikeRung[] | undefined;
}

/**
 * How far a position has come: `filled` when the executor recorded a fill, `awaiting_fill` when the
 * mandate approved it and the executor has not answered yet, `awaiting_owner` while it waits for the
 * owner's approval. All three count as cover, so a run never buys again what is still on its way.
 */
export type PositionState = "filled" | "awaiting_fill" | "awaiting_owner";

/** NO contracts held on one strike of the ladder. */
export interface HeldPosition {
  instrumentSymbol: string;
  strikeCents: number;
  /** Contracts in hundredths. One contract pays 100 cents, so this is also its payout in cents. */
  hundredths: number;
  state: PositionState;
}

/**
 * - `met`: what is held pays the goal's target below the floor, within the tolerance.
 * - `partly_met`: something is held, but less than that.
 * - `not_met`: nothing held pays below the floor.
 * - `nothing_to_cover`: the floor is not below where protection starts (spot, by default), so the goal
 *   calls for no contracts now (`reason` "floor_not_below_ceiling"). With positions held and spot at or
 *   below the floor, `coverOfPlan` measures the goal as planned instead (`belowFloor`).
 * - `cannot_hedge`: the goal calls for protection, but no staircase can be built: no strike below spot
 *   on the ladder nor among the positions held, the ladder is not listed where orders go, or the
 *   holding is too small for 0.01 contracts (`reason`). Never covered.
 */
export type CoverState = "met" | "partly_met" | "not_met" | "nothing_to_cover" | "cannot_hedge";

/**
 * Why a goal has no staircase (`nothing_to_cover` and `cannot_hedge`), or why nothing can be added to a
 * goal not met on the exchange that takes the orders: its ladder lists no strike below spot, does not
 * list the ladder, the holding is too small, or (`no_more_strikes`) what is still missing lies on
 * strikes it does not list.
 */
export type CoverReason =
  | "floor_not_below_ceiling"
  | "no_strike_below_spot"
  | "ladder_not_listed"
  | "holding_too_small"
  | "no_more_strikes";

/** One strike of the goal's staircase, highest first. */
export interface CoverRung {
  instrumentSymbol: string;
  strikeCents: number;
  /** Contracts the staircase calls for at this strike. */
  targetHundredths: number;
  /** Contracts held at exactly this strike. */
  heldHundredths: number;
  /** Contracts to buy here to complete the goal: 0 when it is met. */
  missingHundredths: number;
}

/**
 * Whether positions already held cover a protection goal, measured the same way every time. See
 * `docs/cover.md` for the definition.
 */
export interface CoverAssessment {
  state: CoverState;
  /**
   * Why there is no staircase, for `nothing_to_cover` and `cannot_hedge`; for `partly_met` and
   * `not_met`, why nothing can be added on the exchange that takes the orders. Null otherwise.
   */
  reason: CoverReason | null;
  asset: string;
  eventTicker: string;
  spotCents: number;
  holdingQuantity: string;
  /** Where protection starts, or null when no strike lies below spot. */
  ceilingCents: number | null;
  /** The goal's floor, whatever the ladder lists. */
  floorCents: number | null;
  /**
   * The price below which the staircase pays in full and cover is measured: the floor when it is a
   * strike, otherwise the first strike under the floor. Null when there is no staircase.
   */
  measuredBelowCents: number | null;
  /** What the goal's staircase pays once the price is below `measuredBelowCents`. */
  targetPayoutCents: number;
  /** What every position held on this ladder pays there. */
  heldPayoutCents: number;
  /** `heldPayoutCents` split by how far each position has come. */
  heldByState: Record<PositionState, number>;
  /** `max(0, target - held)`. */
  shortfallCents: number;
  /**
   * Set when spot is at or below the floor and positions are held on the ladder (`coverOfPlan`): the
   * goal is then measured as it was planned, from the spot the plan read down to the floor, and
   * `heldPayoutCents` is what the positions pay if the price settles at today's spot. Null otherwise.
   */
  belowFloor: { plannedSpotCents: number; paysAtSpotCents: number } | null;
  /** A shortfall up to this much still counts as met: rounding and small moves of spot. */
  toleranceCents: number;
  /** held / target in basis points (10000 = 100 %), or null when the target is 0. */
  coverBps: number | null;
  /** Payout the missing contracts add below `measuredBelowCents`: the shortfall, or 0 when met. */
  missingPayoutCents: number;
  /**
   * The part of `missingPayoutCents` a plan can buy on the exchange that takes the orders, on its own
   * strikes: less when the rest lies on strikes it does not list, 0 when nothing can be added.
   */
  addablePayoutCents: number;
  /**
   * True when what cannot be added lies only on strikes below the lowest one the exchange that takes the
   * orders lists (production lists lower strikes than the sandbox). False otherwise, and when everything
   * missing can be added.
   */
  missingBelowVenue: boolean;
  rungs: CoverRung[];
}

/** The cover a plan was made against, and what holding it plus the plan's orders pays. */
export interface PlanCover extends CoverAssessment {
  /** Held positions plus this plan's orders, paid below `measuredBelowCents`. */
  withPlanPayoutCents: number;
  withPlanCoverBps: number | null;
}

/**
 * A hedge signal bought from the signal API, with the receipt of its payment. The `signal` shape is
 * the part of `HedgeSignal` (`@mandate/shared`) the planner reads, so a purchased signal document
 * can be passed as it is.
 */
export interface PaidSignal {
  /** x402 receipt id: the nonce of the payment authorization, which Gateway's transfer history is keyed by. */
  receiptId: string;
  signal: {
    signalId: string;
    asset: string;
    eventTicker: string;
    model: {
      /** Edge, in basis points of a dollar, before a price counts as cheap or expensive. */
      fairBandBps: number;
    };
    strikes: readonly {
      strikeCents: number;
      /** The model's probability, in basis points, that the asset finishes at or above the strike. */
      modelYesBps: number;
    }[];
  };
}

/** How the signal rates a rung's limit price: `unrated` when the signal has no such strike or there is no price. */
export type SignalRating = "cheap" | "fair" | "expensive" | "unrated";

export interface SignalRungRating {
  instrumentSymbol: string;
  strikeCents: number;
  /** The limit price the plan would pay, or null when the rung has no NO offer. */
  limitPriceCents: number | null;
  /** The signal's value of one NO contract, in basis points of a dollar (100 bps = 1 cent). */
  modelNoBps: number | null;
  /** `modelNoBps - limitPriceCents x 100`: positive means the plan pays less than the model value. */
  edgeBps: number | null;
  rating: SignalRating;
  /** Contracts the plan buys at this strike. */
  boughtHundredths: number;
}

/** Whether and how a paid signal shaped the plan. Present only when a signal was given. */
export interface PlanSignalUse {
  receiptId: string;
  signalId: string;
  /** False when the signal does not describe this ladder; the plan then ignores it. */
  used: boolean;
  ignoredBecause: "asset_mismatch" | "event_mismatch" | "no_matching_strikes" | null;
  /**
   * "signal": rungs were bought cheapest first (cheap, fair, unrated, then expensive), so a binding
   * spend cap cuts the expensive ones. "nearest_spot": the default order, used when the signal is ignored.
   */
  buyOrder: "signal" | "nearest_spot";
  /** True when the orders differ from the plan the same inputs give without the signal. */
  changedOrders: boolean;
  /** Each strike the staircase called for, highest first. */
  rungs: SignalRungRating[];
  /** Strikes bought although the signal rates them expensive. */
  expensiveBoughtStrikesCents: number[];
}

/** One order as the agent will submit it. */
export interface PlannedOrder {
  instrumentSymbol: string;
  strikeCents: number;
  side: "no";
  /** Contracts with two decimals, e.g. "25.00". */
  quantity: string;
  quantityHundredths: number;
  limitPriceCents: number;
  /** ceil(quantity x limit price): the most this order can cost. */
  amountCents: number;
}

/**
 * What the same plan would be at a higher slippage (`HedgePlan.depthOptions`): the planner run again with
 * only `slippageCents` changed, so the spending cap, budget, per-trade limit and depth all apply.
 */
export interface DepthOption {
  slippageCents: number;
  /** The cover it gives, in basis points: as `withPlanCoverBps` with positions held, else at the floor. */
  coverBps: number | null;
  /** What its orders commit: the sum of their amounts, as the contract checks them. */
  totalAmountCents: number;
  /** What they cost if they fill at the prices the book showed. */
  expectedFillCents: number;
  orderCount: number;
  /** Each order's amount, in order, for checking them against the mandate's lines. */
  orderAmountsCents: number[];
  /** Strikes still short of the goal for depth, the spending cap or the budget. */
  shortStrikesCents: number[];
  /** True when nothing is short for those reasons: the goal is covered within the cap. */
  coversGoal: boolean;
}

/** One strike of the staircase. A rung may be split into several orders to respect `maxTradeCents`. */
export interface PlannedRung {
  instrumentSymbol: string;
  strikeCents: number;
  side: "no";
  quantity: string;
  quantityHundredths: number;
  /** The size the design called for before cost, budget and depth limits. */
  designedHundredths: number;
  limitPriceCents: number;
  /** Sum of the rung's order amounts. */
  amountCents: number;
  /** What the rung pays if the asset finishes below its strike (one dollar per contract). */
  payoutCents: number;
  /** The price slice this rung offsets: from `coversFromCents` down to `coversToCents`. */
  coversFromCents: number;
  coversToCents: number;
  orders: PlannedOrder[];
  /** The rung's NO price (the listing's quote) the slippage is measured from. Absent on older plans. */
  bestPriceCents?: number | null;
  /** Book levels the rung takes (1 at the best price). Absent on older plans. */
  levelsUsed?: number;
  /**
   * What the rung costs if it fills at the prices the book showed, rounded up to the cent; at most
   * `amountCents`. Without the book's levels, quantity x limit. Absent on older plans.
   */
  expectedFillCents?: number;
}

export interface PayoffPoint {
  /** Final settlement price. NO at strike K pays when the price is below K, not at K. */
  priceCents: number;
  /** Holding's profit or loss against spot, rounded to the cent. */
  unhedgedPnlCents: number;
  /** Hedge payout minus its cost. */
  hedgePnlCents: number;
  netPnlCents: number;
}

export type WarningCode =
  | "category_not_allowed"
  | "no_strike_below_spot"
  | "floor_not_below_ceiling"
  | "ceiling_lowered"
  | "ceiling_above_spot"
  | "no_tail_protection"
  | "market_not_open"
  | "no_price"
  | "below_minimum"
  | "thin_depth"
  | "cost_cap_reached"
  | "budget_exhausted"
  | "trade_cap_too_small"
  | "orders_split"
  | "signal_ignored"
  | "signal_expensive"
  | "already_covered";

export interface PlanWarning {
  code: WarningCode;
  message: string;
  /** Strikes the warning applies to, if any. */
  strikesCents: number[];
}

/** A slice of the protected range the plan does not fully cover, and why. */
export interface UncoveredSlice {
  code: WarningCode;
  /** Upper end of the price slice. */
  fromCents: number;
  /** Lower end of the price slice. */
  toCents: number;
  /** Payout the design wanted for this slice but the plan does not buy. */
  shortfallCents: number;
  strikeCents: number | null;
}

export interface HedgePlan {
  /** Deterministic id derived from the inputs and the orders. */
  planId: string;
  /** "ok": fully as designed; "partial": something was dropped, scaled or is unreachable; "empty": no orders. */
  status: "ok" | "partial" | "empty";
  asset: string;
  eventTicker: string;
  expiry: string;
  spotCents: number;
  /** Normalized holding quantity, e.g. "0.05". */
  holdingQuantity: string;
  ceilingCents: number | null;
  floorCents: number | null;
  /** Highest strike first. */
  rungs: PlannedRung[];
  /** Every order, in the same order as the rungs. */
  orders: PlannedOrder[];
  totals: {
    costCents: number;
    /** Payout if the asset finishes below every rung. */
    maxPayoutCents: number;
    contractsHundredths: number;
    orderCount: number;
    /** min(maxCostCents, remainingBudgetCents). */
    spendCapCents: number;
    /** The range the bought rungs protect, or null when nothing is bought. */
    protectedRange: { fromCents: number; toCents: number } | null;
    /** Holding's loss against spot at the floor. */
    lossAtFloorCents: number | null;
    /** Hedge payout for a finish one cent below the floor. */
    payoutBelowFloorCents: number;
    /** payoutBelowFloorCents / lossAtFloorCents in basis points (10000 = 100 %). */
    coverageAtFloorBps: number | null;
    /** Sum of the rungs' `expectedFillCents`. Absent on older plans. */
    expectedFillCents?: number;
  };
  payoff: PayoffPoint[];
  breakEven: {
    /** The hedge's payout reaches its cost when the asset finishes below this strike. */
    paysForItselfBelowCents: number | null;
    /** Above this price the holding's gain covers the hedge's cost (the hedge pays nothing up there). */
    netBreakEvenAboveCents: number | null;
    notes: string[];
  };
  warnings: PlanWarning[];
  uncovered: UncoveredSlice[];
  /** How a paid signal was used. Absent when no signal was given. */
  signal?: PlanSignalUse;
  /** The cover already held and what this plan adds. Present only when `held` was given. */
  cover?: PlanCover;
  /**
   * When the book is too thin somewhere (`thin_depth`): what the same plan would be at each higher
   * slippage up to 10 cents, kept only where its orders change. Absent otherwise, and on older plans.
   */
  depthOptions?: DepthOption[];
  /** The smallest slippage in `depthOptions` that covers the goal within the cap, or null. */
  coversAtSlippageCents?: number | null;
}
