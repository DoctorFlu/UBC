/**
 * Domain types the console renders. Amounts are integer cents; times are ISO 8601 strings.
 *
 * TODO(@mandate/shared): the contract-facing types (verdicts, reason codes, policy) move to
 * `@mandate/shared` when it lands. Keep these names close to the contract's so the swap is a rename.
 */

/** What the Policy contract decided. */
export type Verdict = "approved" | "held" | "rejected";

/** The full life of an intent as the console shows it: a verdict, then (if approved) a fill result. */
export type IntentStatus = Verdict | "filled" | "unfilled";

/** Every state a status chip can show. "paused" is the mandate state, not an intent state. */
export type StatusKind = IntentStatus | "paused";

/** Why the Policy contract rejected or held an intent. */
export type ReasonCode =
  | "MAX_ORDER_SIZE"
  | "BUDGET_EXCEEDED"
  | "CATEGORY_NOT_ALLOWED"
  | "DAILY_LOSS_LIMIT"
  | "ABOVE_APPROVAL_THRESHOLD"
  | "MANDATE_PAUSED";

export type MarketCategory = "crypto" | "macro" | "politics" | "sports" | "weather";

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export interface Mandate {
  version: number;
  totalBudgetCents: number;
  maxOrderCents: number;
  approvalThresholdCents: number;
  dailyLossLimitCents: number;
  allowedCategories: readonly MarketCategory[];
  paused: boolean;
  updatedAt: string;
  updateTx: Hash;
}

export interface MandateUsage {
  budgetUsedCents: number;
  dailyLossCents: number;
  largestOrderTodayCents: number;
  heldToday: number;
  /** Rejections today, per rule. */
  tripsToday: Partial<Record<ReasonCode, number>>;
}

export interface Market {
  symbol: string;
  title: string;
  category: MarketCategory;
}

export interface Intent {
  id: string;
  createdAt: string;
  market: Market;
  side: "buy" | "sell";
  /** Whole contracts. */
  contracts: number;
  /** Per-contract limit price in cents, 1 to 99. */
  limitPriceCents: number;
  notionalCents: number;
  status: IntentStatus;
  reasonCode?: ReasonCode;
  /** The agent's one-line reason, from its sealed decision context. */
  rationale: string;
  txHash: Hash;
  blockNumber: number;
}

export type LiveSource = "stream" | "poller" | "offline";

export interface LiveStatus {
  source: LiveSource;
  lastEventAt: string;
}

export interface Agent {
  name: string;
  address: Address;
  owner: Address;
  pairedAt: string;
}

export interface Holding {
  asset: string;
  /** Quantity as a decimal string, to stay exact. */
  quantity: string;
  /** Spot price of one unit, in cents. */
  priceCents: number;
  valueCents: number;
}

export interface LadderRung {
  /** Strike in whole dollars. */
  strike: number;
  market: Market;
  askCents: number;
  plannedContracts: number;
}

export interface HedgePlan {
  costCents: number;
  maxPayoutCents: number;
  coveredBelowStrike: number;
  notCovered: string;
}

export interface Payment {
  id: string;
  at: string;
  item: string;
  provider: string;
  priceCents: number;
  settlementTx: Hash;
}

export interface AuditRecord {
  id: string;
  at: string;
  blockNumber: number;
  txHash: Hash;
  event:
    | "IntentSubmitted"
    | "IntentApproved"
    | "IntentHeld"
    | "IntentRejected"
    | "IntentFilled"
    | "PolicySet"
    | "Paused";
  intentId?: string;
  status?: StatusKind;
  reasonCode?: ReasonCode;
  summary: string;
}

export interface SetupStep {
  id: string;
  title: string;
  actor: "owner" | "agent";
  hint: string;
  done: boolean;
}

export interface ChangeRequest {
  id: string;
  at: string;
  field: keyof Pick<
    Mandate,
    "totalBudgetCents" | "maxOrderCents" | "approvalThresholdCents" | "dailyLossLimitCents"
  >;
  fromCents: number;
  toCents: number;
  reason: string;
}

export const reasonLabels: Record<ReasonCode, string> = {
  MAX_ORDER_SIZE: "Order larger than the max order size",
  BUDGET_EXCEEDED: "Would exceed the total budget",
  CATEGORY_NOT_ALLOWED: "Market category not allowed",
  DAILY_LOSS_LIMIT: "Daily loss limit reached",
  ABOVE_APPROVAL_THRESHOLD: "Above the approval threshold",
  MANDATE_PAUSED: "Mandate is paused",
};

export const categoryLabels: Record<MarketCategory, string> = {
  crypto: "Crypto",
  macro: "Macro",
  politics: "Politics",
  sports: "Sports",
  weather: "Weather",
};
