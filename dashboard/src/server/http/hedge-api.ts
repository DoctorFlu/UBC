import "server-only";

import type { HedgeMarketResponse, PreviewState } from "@/lib/hedge/types";

import type { ConsoleService } from "../console-service";
import { type MarketQuotes, ladderQuotes } from "../market/quotes";
import { previewPlan } from "../market/preview";
import { apiError, json } from "./responses";

const ASSET = /^[A-Z0-9]{2,10}$/;
const EVENT = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * GET /api/console/hedge/market?asset=BTC[&event=BTC2611202200][&preview=1]
 *
 * Live quotes for the ladder a plan is on (the agent's latest plan for the asset, unless `event` names
 * another), and with `preview=1` a preview plan for an asset the agent has not planned. Read-only: it
 * changes nothing and needs no signature, like the snapshot. Gemini failing is part of the answer, not
 * an error status, so the view can keep showing the stored plan.
 */
export async function getHedgeMarket(
  request: Request,
  service: ConsoleService,
  quotes: MarketQuotes,
): Promise<Response> {
  const url = new URL(request.url);
  const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
  if (!ASSET.test(asset)) {
    return apiError(422, "invalid_parameter", "asset must be a ticker such as BTC.");
  }
  const event = url.searchParams.get("event");
  if (event !== null && !EVENT.test(event)) {
    return apiError(422, "invalid_parameter", "event must be a Gemini event ticker.");
  }
  const snapshot = service.snapshot();
  const agentPlan = snapshot.offchain.plans.find((plan) => plan.asset === asset) ?? null;
  const eventTicker = event ?? agentPlan?.plan.eventTicker ?? null;
  const wantsPreview = url.searchParams.get("preview") === "1" && agentPlan === null;

  const lookup = await quotes.ladder(asset, eventTicker);
  let preview: PreviewState = { status: "not_requested" };
  if (wantsPreview) {
    preview = lookup.ok
      ? previewPlan({
          asset,
          holdings: snapshot.offchain.holdings,
          rules: snapshot.chain?.rules ?? null,
          committedCents: snapshot.chain?.committedCents ?? 0,
          ladder: lookup.ladder,
        })
      : { status: "unavailable", reason: "A preview needs Gemini's live quotes, and they are unavailable." };
  }

  const body: HedgeMarketResponse = {
    asset,
    eventTicker,
    quotes: lookup.ok ? ladderQuotes(lookup.ladder) : null,
    error: lookup.ok ? null : lookup.error,
    preview,
  };
  return json(body);
}
