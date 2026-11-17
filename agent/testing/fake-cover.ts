/**
 * The cover the fake console reports in `GET /summary` (issue #97), measured the way the real console
 * measures it: the latest plan per asset with a floor, on a ladder not expired yet, against the
 * positions the chain records and the ladder Gemini quotes now, with the planner's `coverOfPlan`.
 * A ladder or chain that cannot be read makes the goal `unavailable`, as in the console.
 */
import type { Ladder } from "@mandate/gemini";
import { coverOfPlan, type RecordedIntent } from "@mandate/planner";
import type { CoverNowView } from "@mandate/shared";
import * as z from "zod";
import type { FakeConsoleState } from "./fake-console";

const planGoalSchema = z.object({
  asset: z.string(),
  eventTicker: z.string(),
  expiry: z.string(),
  floorCents: z.int().nullable(),
  ceilingCents: z.int().nullable(),
  spotCents: z.int(),
  holdingQuantity: z.string(),
});

/** The console measures at most this many goals, like its price wake-ups. */
const MAX_GOALS = 4;

export function coverFromPlans(sources: {
  /** The goal's ladder as Gemini quotes it now; a rejection makes the goal unavailable. */
  ladder: (asset: string, eventTicker: string) => Promise<Ladder>;
  /** Every intent the chain records; a rejection makes every goal unavailable. */
  intents: () => Promise<RecordedIntent[]>;
  now?: () => Date;
}): (state: FakeConsoleState) => Promise<CoverNowView[]> {
  return async (state) => {
    const now = (sources.now ?? (() => new Date()))().getTime();
    const latest = new Map<string, { planId: string; plan: z.infer<typeof planGoalSchema> }>();
    const stored = [...state.plans.values()].sort((a, b) => b.storedAt.localeCompare(a.storedAt));
    for (const entry of stored) {
      const parsed = planGoalSchema.safeParse(entry.plan);
      if (!parsed.success || latest.has(entry.asset)) continue;
      latest.set(entry.asset, { planId: entry.planId, plan: parsed.data });
    }
    const goals = [...latest.values()]
      .filter(({ plan }) => plan.floorCents !== null && Date.parse(plan.expiry) > now)
      .slice(0, MAX_GOALS);
    const intents = await sources.intents().catch(() => null);
    return Promise.all(
      goals.map(async ({ planId, plan }) => {
        const goal = {
          asset: plan.asset,
          eventTicker: plan.eventTicker,
          expiresAt: plan.expiry,
          planId,
          floorCents: plan.floorCents,
        };
        const unavailable: CoverNowView = {
          ...goal,
          state: "unavailable",
          spotCents: null,
          measuredBelowCents: null,
          targetPayoutCents: null,
          heldPayoutCents: null,
          heldByState: null,
          coverBps: null,
          missingPayoutCents: null,
        };
        if (intents === null) return unavailable;
        const ladder = await sources.ladder(plan.asset, plan.eventTicker).catch(() => null);
        if (ladder === null) return unavailable;
        const holding = state.holdings.find((h) => h.asset === plan.asset)?.quantity ?? null;
        const cover = coverOfPlan({
          plan,
          holdingQuantity: holding,
          ladder,
          spotCents: ladder.spot.midCents,
          intents,
        });
        if (cover === null) return unavailable;
        const { assessment } = cover;
        return {
          ...goal,
          state: assessment.state,
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
        };
      }),
    );
  };
}
