import type { Tool } from "../mcp/tool";
import { executePlan } from "./execute-plan";
import { getActivity } from "./get-activity";
import { getIntent } from "./get-intent";
import { getLadder } from "./get-ladder";
import { getPolicy } from "./get-policy";
import { getPortfolio } from "./get-portfolio";
import { getSetupState } from "./get-setup-state";
import { listMarkets } from "./list-markets";
import { ping } from "./ping";
import { planHedge } from "./plan-hedge";
import { proposeTrade } from "./propose-trade";
import { requestPairing } from "./request-pairing";
import { simulateTrade } from "./simulate-trade";
import { whoami } from "./whoami";

/**
 * Every tool the server exposes.
 *
 * To add a tool, create `src/tools/<name>.ts` with `defineTool`, then add its import above and one
 * entry below. Keep both lists alphabetical so tools added in parallel rarely touch the same lines.
 */
// prettier-ignore
export const tools: readonly Tool[] = [
  executePlan,
  getActivity,
  getIntent,
  getLadder,
  getPolicy,
  getPortfolio,
  getSetupState,
  listMarkets,
  ping,
  planHedge,
  proposeTrade,
  requestPairing,
  simulateTrade,
  whoami,
];
