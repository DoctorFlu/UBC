import type { Ladder } from "@mandate/gemini";

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
  /** Cents added to each NO price to form the limit price (capped at 99). Default 0. */
  slippageCents?: number;
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
  | "orders_split";

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
}
