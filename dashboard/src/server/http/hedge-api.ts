import "server-only";

import { KNOWN_ASSETS } from "@mandate/gemini";

import { assetGoals } from "@/lib/hedge/goals";
import type { HedgeMarketResponse, PreviewState } from "@/lib/hedge/types";

import type { ConsoleService, MandateScope } from "../console-service";
import { coverOfSnapshot } from "../cover-summary";
import { type MarketQuotes, ladderQuotes } from "../market/quotes";
import { previewPlan } from "../market/preview";
import { apiError, json } from "./responses";
import { consoleRoute } from "./session";

const ASSETS: ReadonlySet<string> = new Set(KNOWN_ASSETS);

/**
 * GET /api/console/hedge/market?asset=BTC[&event=BTC2611202200][&preview=1]
 *
 * Live quotes for the ladder of one of the asset's goals (`event`; by default the goal that ends soonest),
 * or the soonest weekly ladder when the agent has planned none, with the cover state of each of the asset's
 * goals for the Hedge page's goal row. With `preview=1`, a preview plan for an asset the agent has not
 * planned.
 * Read-only: it changes nothing and needs no signature, like the snapshot. Gemini failing is part of the
 * answer, not an error status, so the view can keep showing the stored plan.
 *
 * It needs a session, and every distinct question costs a Gemini request from the shared rate limit. So
 * a caller cannot choose what is asked: the asset must be one Gemini lists, and `event`, when given, must
 * be the event of one of the goal plans the console stores for that asset in the session's mandate.
 * Anything else is refused before Gemini is called.
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
  const now = Date.now();
  const plans = snapshot.offchain.plans.filter((plan) => plan.asset === asset);
  const event = url.searchParams.get("event");
  if (event !== null && !plans.some((plan) => plan.plan.eventTicker === event)) {
    return apiError(
      422,
      "invalid_parameter",
      `event must be the event of one of the agent's goals for ${asset}, or left out.`,
    );
  }
  const goals = assetGoals(plans, asset, now);
  const agentPlan =
    (event === null ? goals[0] : plans.find((plan) => plan.plan.eventTicker === event)) ?? null;
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

  // Each goal's cover, measured like "Cover now" on the same cached quotes (one read per event).
  const covers =
    goals.length > 1
      ? await coverOfSnapshot(
          { ...snapshot, offchain: { ...snapshot.offchain, plans: goals } },
          (goalAsset, goalEvent) => quotes.ladder(goalAsset, goalEvent),
          now,
        )
      : [];
  const body: HedgeMarketResponse = {
    asset,
    eventTicker,
    quotes: lookup.ok ? ladderQuotes(lookup.ladder, lookup.elsewhere, lookup.listed) : null,
    error: lookup.ok ? null : lookup.error,
    preview,
    goals: covers.map((cover) => ({ eventTicker: cover.eventTicker, state: cover.state })),
  };
  return json(body);
}
