import { describe, expect, it } from "vitest";

import { mandatePath, viewPathOf, withMandate } from "./mandate-path";

describe("mandate paths (#95)", () => {
  it("puts every view under its mandate", () => {
    expect(mandatePath("mnd_abc")).toBe("/m/mnd_abc");
    expect(mandatePath("mnd_abc", "/")).toBe("/m/mnd_abc");
    expect(mandatePath("mnd_abc", "/activity/3")).toBe("/m/mnd_abc/activity/3");
    expect(() => mandatePath("mnd_abc", "approvals")).toThrow();
  });

  it("reads the mandate and the view back from a pathname", () => {
    expect(viewPathOf("/m/mnd_abc")).toEqual({ mandateId: "mnd_abc", path: "/" });
    expect(viewPathOf("/m/mnd_abc/")).toEqual({ mandateId: "mnd_abc", path: "/" });
    expect(viewPathOf("/m/mnd_abc/hedge/plans/p1")).toEqual({
      mandateId: "mnd_abc",
      path: "/hedge/plans/p1",
    });
    expect(viewPathOf("/")).toBeNull();
    expect(viewPathOf("/m/")).toBeNull();
    expect(viewPathOf("/mandates/new")).toBeNull();
  });

  it("names the mandate on an API URL, keeping its query", () => {
    expect(withMandate("/api/console/snapshot", "mnd_abc")).toBe("/api/console/snapshot?mandate=mnd_abc");
    expect(withMandate("/api/console/hedge/market?asset=BTC", "mnd_abc")).toBe(
      "/api/console/hedge/market?asset=BTC&mandate=mnd_abc",
    );
  });
});
