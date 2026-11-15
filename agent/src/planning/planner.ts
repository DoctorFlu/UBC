import { planHedge, summarizePlan } from "@mandate/planner";
import type { HedgePlanner } from "../services";

/** Bump when the planning model changes in a way that changes plans for the same inputs. */
export const PLANNER_VERSION = "1";

export function createHedgePlanner(): HedgePlanner {
  return { version: PLANNER_VERSION, plan: planHedge, summarize: summarizePlan };
}
