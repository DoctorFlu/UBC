import "server-only";

import type { ConsoleHolding, CoverNowView, IntentView } from "@mandate/shared";

import { coverNow } from "@/features/hedge/cover-now";
import type { AgentPlanView } from "@/lib/hedge/types";
import type { ConsoleSnapshot } from "@/lib/live/types";

import { ladderQuotes } from "./market/quotes";
import { currentGoals, type LadderSource } from "./wake";

/**
 * The cover held now against each of one mandate's current goals: the Hedge page's "Cover now", measured
 * the same way (`coverNow`) on the same cached quotes. The agent's daily digest (#97) and the workspace
 * Home (#95) both read it, each for one mandate's snapshot only. A goal whose quotes do not answer, or a
 * snapshot without the chain, is `unavailable`, never a guess.
 */
export async function coverOfSnapshot(
  snapshot: ConsoleSnapshot,
  ladder: LadderSource,
  now = Date.now(),
): Promise<CoverNowView[]> {
  // Without the chain the console cannot count what is held: unavailable, never "not covered".
  const intents = snapshot.chain?.intents ?? null;
  return Promise.all(
    currentGoals(snapshot.offchain.plans, now).map((view) =>
      coverOfGoal(view, snapshot.offchain.holdings, intents, ladder),
    ),
  );
}

async function coverOfGoal(
  view: AgentPlanView,
  holdings: readonly ConsoleHolding[],
  intents: readonly IntentView[] | null,
  ladder: LadderSource,
): Promise<CoverNowView> {
  const { plan } = view;
  const goal = {
    asset: plan.asset,
    eventTicker: plan.eventTicker,
    expiresAt: plan.expiry,
    planId: view.planId,
    floorCents: plan.floorCents,
  };
  const unavailable: CoverNowView = {
    ...goal,
    state: "unavailable",
    reason: null,
    belowFloor: null,
    spotCents: null,
    measuredBelowCents: null,
    targetPayoutCents: null,
    heldPayoutCents: null,
    heldByState: null,
    coverBps: null,
    missingPayoutCents: null,
    missingBelowVenue: false,
  };
  if (intents === null) return unavailable;
  const lookup = await ladder(plan.asset, plan.eventTicker).catch(() => ({ ok: false as const }));
  if (!lookup.ok) return unavailable;
  // The saved holding, else the one the plan was sized for (a goal planned before any holding was saved).
  const holding =
    holdings.find((candidate) => candidate.asset === plan.asset)?.quantity ?? plan.holdingQuantity;
  const cover = coverNow({
    plan,
    holdingQuantity: holding,
    quotes: ladderQuotes(lookup.ladder, lookup.elsewhere, lookup.listed),
    intents,
  });
  if (!cover) return unavailable;
  const { assessment } = cover;
  return {
    ...goal,
    state: assessment.state,
    reason: assessment.reason,
    belowFloor: assessment.belowFloor,
    spotCents: assessment.spotCents,
    measuredBelowCents: assessment.measuredBelowCents,
    targetPayoutCents: assessment.targetPayoutCents,
    heldPayoutCents: assessment.heldPayoutCents,
    heldByState: {
      filledCents: assessment.heldByState.filled,
      awaitingFillCents: assessment.heldByState.awaiting_fill,
      awaitingOwnerCents: assessment.heldByState.awaiting_owner,
    },
    coverBps: assessment.coverBps,
    missingPayoutCents: assessment.missingPayoutCents,
    missingBelowVenue: assessment.missingBelowVenue,
  };
}
