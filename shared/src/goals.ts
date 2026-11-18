/**
 * A mandate's goals: one per (asset, event), so a daily and a weekly hedge of the same holding are two
 * goals, each with its own floor and ladder.
 *
 * Which stored plans are goals: for each asset, its newest plan, and every plan with at least one order
 * proposed to the contract (an intent the contract rejected still counts). Of those, the newest per
 * (asset, event) is that event's goal. So the newest plan for an asset supersedes the asset's older plans
 * that never reached the contract, and a plan that did stays a goal until its ladder expires.
 */

/** What goal selection reads of a stored plan. */
export interface GoalCandidate {
  planId: string;
  asset: string;
  eventTicker: string;
}

/**
 * The goal plans among `plans`, which must be newest first; they come back newest first. `proposed` holds
 * the ids of plans with at least one order proposed to the contract. Expiry is not judged here: a goal
 * whose ladder expired is still the latest word on that event, and callers that measure cover drop it.
 */
export function selectGoalPlans<T>(
  plans: readonly T[],
  candidate: (plan: T) => GoalCandidate,
  proposed: ReadonlySet<string>,
): T[] {
  const newestOfAsset = new Set<string>();
  const taken = new Set<string>();
  const goals: T[] = [];
  for (const plan of plans) {
    const { planId, asset, eventTicker } = candidate(plan);
    const newest = !newestOfAsset.has(asset);
    newestOfAsset.add(asset);
    if (!newest && !proposed.has(planId)) continue;
    const key = `${asset}\u0000${eventTicker}`;
    if (taken.has(key)) continue;
    taken.add(key);
    goals.push(plan);
  }
  return goals;
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * When a goal ends, in plain words: "today, 22:00 UTC" on the UTC day of `now`, otherwise its day, as in
 * "Fri 20 Nov". Never the ladder's ticker.
 */
export function goalEnds(expiry: string, now: number): string {
  const at = Date.parse(expiry);
  if (!Number.isFinite(at)) return "an unknown date";
  if (utcDay(at) === utcDay(now)) return `today, ${TIME.format(at)} UTC`;
  return DAY.format(at).replace(",", "");
}

/** A goal named for the owner: "BTC, through today, 22:00 UTC" or "BTC, through Fri 20 Nov". */
export function goalLabel(asset: string, expiry: string, now: number): string {
  return `${asset}, through ${goalEnds(expiry, now)}`;
}
