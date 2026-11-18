import "server-only";

import { KNOWN_ASSETS } from "@mandate/gemini";

import type { HedgeMarketResponse, PreviewState } from "@/lib/hedge/types";

import type { ConsoleService, MandateScope } from "../console-service";
import { type MarketQuotes, ladderQuotes } from "../market/quotes";
import { previewPlan } from "../market/preview";
import { apiError, json } from "./responses";
import { consoleRoute } from "./session";

const ASSETS: ReadonlySet<string> = new Set(KNOWN_ASSETS);

/**
 * GET /api/console/hedge/market?asset=BTC[&event=BTC2611202200][&preview=1]
 *
 * Live quotes for the ladder the agent's latest plan for the asset is on (or the soonest weekly ladder
 * when it has none), and with `preview=1` a preview plan for an asset the agent has not planned.
 * Read-only: it changes nothing and needs no signature, like the snapshot. Gemini failing is part of the
 * answer, not an error status, so the view can keep showing the stored plan.
 *
 * It needs a session, and every distinct question costs a Gemini request from the shared rate limit. So
 * a caller cannot choose what is asked: the asset must be one Gemini lists, and `event`, when given, must
 * be the event of the plan the console stores for that asset in the session's mandate. Anything else is
 * refused before Gemini is called.
 */
export function getHedgeMarket(
  request: Request,
  service: ConsoleService,
  quotes: MarketQuotes,
): Promise<Response> {
  return consoleRoute((_request, _service, { mandate }) => hedgeMarket(request, service, mandate, quotes))(
    request,
    service,
  );
}

async function hedgeMarket(
  request: Request,
  service: ConsoleService,
  mandate: MandateScope,
  quotes: MarketQuotes,
): Promise<Response> {
  const url = new URL(request.url);
  const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
  if (!ASSETS.has(asset)) {
    return apiError(
      422,
      "invalid_parameter",
      `asset must be one Gemini lists ladders for: ${KNOWN_ASSETS.join(", ")}.`,
    );
  }
  const snapshot = service.snapshot(mandate);
  const agentPlan = snapshot.offchain.plans.find((plan) => plan.asset === asset) ?? null;
  const event = url.searchParams.get("event");
  if (event !== null && event !== agentPlan?.plan.eventTicker) {
    return apiError(
      422,
      "invalid_parameter",
      `event must be the event of the agent's stored plan for ${asset}, or left out.`,
    );
  }
  const eventTicker = agentPlan?.plan.eventTicker ?? null;
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
    quotes: lookup.ok ? ladderQuotes(lookup.ladder, lookup.elsewhere, lookup.listed) : null,
    error: lookup.ok ? null : lookup.error,
    preview,
  };
  return json(body);
}
