/**
 * What the console sends the hedge view: the agent's stored plans (in the live snapshot) and live ladder
 * quotes with an optional preview (from GET /api/console/hedge/market). Plain JSON only.
 */
import type { HedgePlan } from "@mandate/planner";

/** A plan the agent's MCP server posted (POST /api/agent/v1/plans), as stored. */
export interface AgentPlanView {
  planId: string;
  asset: string;
  /** The owner's request that led to it, in their words. */
  requestText: string;
  /** When the agent made the plan. */
  createdAt: string;
  /** When the console stored it. */
  storedAt: string;
  plan: HedgePlan;
}

export interface QuoteRung {
  instrumentSymbol: string;
  strikeCents: number;
  label: string | null;
  marketState: string | null;
  /** Price to buy one NO contract now. */
  noBuyCents: number | null;
  yesBidCents: number | null;
  yesAskCents: number | null;
}

export interface LadderQuotes {
  asset: string;
  eventTicker: string;
  title: string;
  expiry: string;
  /** Mid of Gemini's spot bid and ask, the price the planner measures from. */
  spotCents: number;
  fetchedAt: string;
  /** Highest strike first. */
  rungs: QuoteRung[];
}

export interface MarketDataError {
  code:
    "no_ladder" | "rate_limited" | "unreachable" | "invalid_response" | "invalid_argument" | "unavailable";
  message: string;
}

/** The inputs a preview was planned with, shown next to it so nobody mistakes it for the agent's plan. */
export interface PreviewAssumptions {
  holdingQuantity: string;
  dropPercent: number;
  maxCostCents: number;
  maxTradeCents: number;
  remainingBudgetCents: number;
}

export type PreviewState =
  | { status: "ready"; plan: HedgePlan; assumptions: PreviewAssumptions }
  /** Why no preview could be computed, in one sentence. */
  | { status: "unavailable"; reason: string }
  /** The asset has a plan from the agent, or the view did not ask for a preview. */
  | { status: "not_requested" };

export interface HedgeMarketResponse {
  asset: string;
  /** The event asked about, or null for the soonest weekly ladder. */
  eventTicker: string | null;
  quotes: LadderQuotes | null;
  error: MarketDataError | null;
  preview: PreviewState;
}

/** The protection a preview assumes: from spot down to this far below it. */
export const PREVIEW_DROP_PERCENT = 10;
