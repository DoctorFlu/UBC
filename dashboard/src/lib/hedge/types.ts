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
  /**
   * False when the exchange orders go to does not list this ladder: `rungs` is then empty and the strikes
   * are production's, in `elsewhere`, for the cover of positions held there.
   */
  listed: boolean;
  title: string;
  expiry: string;
  /**
   * Spot, the price the planner measures from: Gemini production's BTC/USD price on every venue (the
   * ladder settles on its index), the mid of bid and ask, or the last trade when `spotBasis` says so.
   */
  spotCents: number;
  /** `mid` of bid and ask, or `last` trade when the spread was too wide for a mid. */
  spotBasis: "mid" | "last";
  /**
   * Strikes Gemini's production exchange lists on this event that the venue's ladder lacks, for cover of
   * the simulated venue's earlier fills there; null when production could not be read.
   */
  elsewhere: { instrumentSymbol: string; strikeCents: number }[] | null;
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
