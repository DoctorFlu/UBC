import type { HedgePlan, PlannedRung } from "@mandate/planner";
import { describe, expect, it } from "vitest";

import { sampleHedgePlan } from "@/fixtures/samples";

import { notCoveredSentence } from "./not-covered";

type PlanInput = Parameters<typeof notCoveredSentence>[0];

function plan(spotCents: number, strikes: number[], range: HedgePlan["totals"]["protectedRange"]): PlanInput {
  return {
    spotCents,
    rungs: strikes.map((strikeCents) => ({ strikeCents }) as PlannedRung),
    totals: { ...sampleHedgePlan.totals, protectedRange: range },
  };
}

describe("notCoveredSentence", () => {
  it("names the gap between spot and the highest strike, then the fall below the floor", () => {
    expect(
      notCoveredSentence(
        plan(6_558_600, [6_500_000, 6_400_000], { fromCents: 6_558_600, toCents: 6_200_000 }),
      ),
    ).toBe(
      "A fall from $65,586 to $65,000, before the first rung pays, and any fall below $62,000, where the payout stops growing.",
    );
  });

  it("leaves out the first clause when a strike sits at or above spot, never printing an empty range", () => {
    const sentence = notCoveredSentence(
      plan(6_500_000, [6_500_000, 6_400_000], { fromCents: 6_500_000, toCents: 6_200_000 }),
    );
    expect(sentence).toBe("Any fall below $62,000, where the payout stops growing.");
    expect(sentence).not.toMatch(/\$65,000 to \$65,000/);
  });

  it("says everything is exposed when the plan buys nothing", () => {
    expect(notCoveredSentence(plan(6_500_000, [], null))).toBe("Everything: the plan buys no contracts.");
  });

  it("never repeats one price as a range for the sample plan the hedge view shows", () => {
    const sentence = notCoveredSentence(sampleHedgePlan);
    expect(sentence).not.toMatch(/(\$[\d,]+) to \1\b/);
  });
});
