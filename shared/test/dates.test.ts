import { describe, expect, it } from "vitest";
import { formatEasternTime } from "../src/dates";

describe("formatEasternTime", () => {
  it("writes the weekday the owner would say, so an agent copies it instead of working it out", () => {
    // 20 Nov 2026 is a Friday; the Grok Bot once called it "Thu Nov 20".
    expect(formatEasternTime("2026-11-20T22:00:00Z")).toBe("Fri Nov 20, 2026, 5:00 PM ET");
  });

  it("follows daylight saving time", () => {
    expect(formatEasternTime("2026-07-31T21:00:00Z")).toBe("Fri Jul 31, 2026, 5:00 PM ET");
    // Clocks spring forward at 2:00 AM EST (07:00 UTC) on Sun Mar 8, 2026.
    expect(formatEasternTime("2026-03-08T06:30:00Z")).toBe("Sun Mar 8, 2026, 1:30 AM ET");
    expect(formatEasternTime("2026-03-08T07:30:00Z")).toBe("Sun Mar 8, 2026, 3:30 AM ET");
  });

  it("gives the Eastern day, which is the day before for a late UTC time", () => {
    expect(formatEasternTime("2026-11-21T02:00:00Z")).toBe("Fri Nov 20, 2026, 9:00 PM ET");
  });

  it("uses plain spaces on every ICU version and takes a Date too", () => {
    const text = formatEasternTime(new Date(Date.UTC(2026, 0, 1, 5, 5)));
    expect(text).toBe("Thu Jan 1, 2026, 12:05 AM ET");
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it("returns text that is not a date unchanged", () => {
    expect(formatEasternTime("soon")).toBe("soon");
  });
});
