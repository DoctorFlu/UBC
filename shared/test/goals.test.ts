import { describe, expect, it } from "vitest";

import { goalEnds, goalLabel, selectGoalPlans } from "../src/goals";

const NOW = Date.parse("2026-11-18T12:00:00Z");

describe("goal names", () => {
  it("says today with the time on the day the ladder settles, in UTC", () => {
    expect(goalEnds("2026-11-18T22:00:00Z", NOW)).toBe("today, 22:00 UTC");
    expect(goalLabel("BTC", "2026-11-18T22:00:00.000Z", NOW)).toBe("BTC, through today, 22:00 UTC");
  });

  it("names the day otherwise, never the ticker", () => {
    expect(goalLabel("BTC", "2026-11-20T22:00:00Z", NOW)).toBe("BTC, through Fri 20 Nov");
    // The UTC day decides: 00:30 UTC tomorrow is not today, whatever the reader's zone.
    expect(goalEnds("2026-11-19T00:30:00Z", NOW)).toBe("Thu 19 Nov");
  });

  it("does not guess a date it cannot read", () => {
    expect(goalEnds("not a date", NOW)).toBe("an unknown date");
  });
});

describe("selectGoalPlans", () => {
  const plan = (planId: string, eventTicker: string, asset = "BTC") => ({ planId, asset, eventTicker });
  const pick = (plans: ReturnType<typeof plan>[], proposed: string[]) =>
    selectGoalPlans(plans, (p) => p, new Set(proposed)).map((p) => p.planId);

  it("keeps the newest plan of each asset and each proposed plan, one per event, newest first", () => {
    const newestFirst = [
      plan("daily", "D"),
      plan("weekly-2", "W"),
      plan("weekly-1", "W"),
      plan("eth", "E", "ETH"),
    ];
    expect(pick(newestFirst, ["weekly-1"])).toEqual(["daily", "weekly-1", "eth"]);
    expect(pick(newestFirst, ["weekly-1", "weekly-2"])).toEqual(["daily", "weekly-2", "eth"]);
    expect(pick(newestFirst, [])).toEqual(["daily", "eth"]);
  });

  it("has no goal without a plan", () => {
    expect(pick([], ["x"])).toEqual([]);
  });
});
