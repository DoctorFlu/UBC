import type { CoverNowView } from "@mandate/shared";

/** What goal ordering reads of a stored plan. */
interface GoalPlan {
  asset: string;
  plan: { eventTicker: string; expiry: string };
}

/**
 * One asset's goals as the Hedge page shows them: the console's goal plans for the asset (one per event)
 * whose ladder has not expired, soonest first. When every one has expired, the newest alone, so the page
 * can say how its ladder ended. `plans` are the snapshot's goal plans, newest first.
 */
export function assetGoals<T extends GoalPlan>(plans: readonly T[], asset: string, now: number): T[] {
  const mine = plans.filter((view) => view.asset === asset);
  const open = mine
    .filter((view) => Date.parse(view.plan.expiry) > now)
    .sort((a, b) => Date.parse(a.plan.expiry) - Date.parse(b.plan.expiry));
  return open.length > 0 ? open : mine.slice(0, 1);
}

/** A goal's cover in two or three words, for the goal row. */
export function goalStateText(state: CoverNowView["state"] | null): string {
  switch (state) {
    case "met":
      return "Covered";
    case "partly_met":
      return "Partly covered";
    case "not_met":
    case "cannot_hedge":
      return "Not covered";
    case "nothing_to_cover":
      return "Nothing to protect";
    case "unavailable":
      return "Can't measure now";
    case null:
      return "Measuring";
  }
}
