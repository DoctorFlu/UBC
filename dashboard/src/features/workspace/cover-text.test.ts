import { describe, expect, it } from "vitest";

import { coverText, goalsCoveredText, totalCover } from "./cover-text";

const row = (goals: number, met: number, unavailable: number) => ({
  cover: { goals, met, short: goals - met - unavailable, unavailable },
});

describe("Home's cover figures", () => {
  it("says Unknown, never 0 of N, when no goal's cover can be measured (Gemini's quotes unavailable)", () => {
    const cover = totalCover([row(1, 0, 1)]);
    expect(goalsCoveredText(cover)).toEqual({ value: "Unknown", hint: "Can't measure it right now" });
    expect(coverText(cover)).toEqual({ value: "Unknown", hint: "Can't measure it right now" });
  });

  it("counts what it can measure and says how many it cannot", () => {
    const cover = totalCover([row(2, 1, 0), row(1, 0, 1)]);
    expect(cover).toEqual({ goals: 3, met: 1, unavailable: 1 });
    expect(goalsCoveredText(cover)).toEqual({ value: "1 of 3", hint: "1 can't be measured now" });
    expect(coverText(row(2, 1, 1).cover)).toEqual({
      value: "1 of 2",
      hint: "goals covered; 1 can't be measured now",
    });
  });

  it("is N of M, with no hint on the headline, when every goal can be measured", () => {
    expect(goalsCoveredText(totalCover([row(1, 1, 0), row(1, 0, 0)]))).toEqual({ value: "1 of 2" });
    expect(coverText(row(1, 1, 0).cover)).toEqual({ value: "1 of 1", hint: "goal covered" });
    expect(coverText(row(2, 0, 0).cover)).toEqual({ value: "0 of 2", hint: "goals covered" });
  });

  it("says no goal is set with no mandate, or no goal on any", () => {
    expect(totalCover([])).toEqual({ goals: 0, met: 0, unavailable: 0 });
    expect(goalsCoveredText(totalCover([]))).toEqual({ value: "None set" });
    expect(goalsCoveredText(totalCover([row(0, 0, 0)]))).toEqual({ value: "None set" });
    expect(coverText(row(0, 0, 0).cover)).toEqual({ value: "No goals", hint: "No current hedge goal" });
  });
});
