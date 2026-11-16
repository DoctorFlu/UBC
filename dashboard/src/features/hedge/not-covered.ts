import type { HedgePlan } from "@mandate/planner";

import { formatUsdCents } from "@/lib/format";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

/**
 * What the plan leaves exposed, in words. A NO at strike K pays only when the price settles below K,
 * so a fall from spot down to the highest strike pays nothing, and below the lowest covered price the
 * payout stops growing. A clause whose range is empty is left out, never printed as "$X to $X".
 */
export function notCoveredSentence(plan: Pick<HedgePlan, "spotCents" | "rungs" | "totals">): string {
  const range = plan.totals.protectedRange;
  if (!range || plan.rungs.length === 0) return "Everything: the plan buys no contracts.";
  const firstPays = Math.max(...plan.rungs.map((rung) => rung.strikeCents));
  const clauses: string[] = [];
  if (firstPays < plan.spotCents) {
    clauses.push(`a fall from ${usd(plan.spotCents)} to ${usd(firstPays)}, before the first rung pays`);
  }
  if (range.toCents > 0) {
    clauses.push(`any fall below ${usd(range.toCents)}, where the payout stops growing`);
  }
  if (clauses.length === 0) return "Nothing between spot and zero.";
  const sentence = clauses.join(", and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
