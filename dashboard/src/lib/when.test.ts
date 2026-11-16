import { describe, expect, it } from "vitest";

import { exactUtc, relativeTime } from "./when";

const now = new Date("2026-11-16T23:30:00Z");
const options = { now, timeZone: "America/Vancouver", locale: "en-US" };

describe("relativeTime", () => {
  it("says just now for the last minute", () => {
    expect(relativeTime(new Date("2026-11-16T23:29:30Z"), options)).toBe("Just now");
  });

  it("counts minutes for the last hour", () => {
    expect(relativeTime(new Date("2026-11-16T23:28:00Z"), options)).toBe("2 min ago");
    expect(relativeTime(new Date("2026-11-16T22:31:00Z"), options)).toBe("59 min ago");
  });

  it("gives today and yesterday on the owner's own clock, not UTC's", () => {
    // 23:30 UTC is 15:30 in Vancouver, so 07:10 UTC on the same date is still the day before there.
    expect(relativeTime(new Date("2026-11-16T20:05:00Z"), options)).toBe("Today, 12:05 PM");
    expect(relativeTime(new Date("2026-11-16T07:10:00Z"), options)).toBe("Yesterday, 11:10 PM");
  });

  it("names the day for older moments, and the year only when it differs", () => {
    expect(relativeTime(new Date("2026-11-10T18:00:00Z"), options)).toBe("Nov 10, 10:00 AM");
    expect(relativeTime(new Date("2025-11-10T18:00:00Z"), options)).toBe("Nov 10, 2025, 10:00 AM");
  });

  it("does not call a moment in the future recent", () => {
    expect(relativeTime(new Date("2026-11-16T23:45:00Z"), options)).toBe("Today, 3:45 PM");
  });
});

describe("exactUtc", () => {
  it("gives the full UTC moment to the second", () => {
    expect(exactUtc(new Date("2026-11-16T23:20:47Z"))).toBe("16 Nov 2026, 23:20:47 UTC");
  });
});
