import { describe, expect, it } from "vitest";

import { health } from "./health";

describe("GET /api/health", () => {
  it("answers ok with the feed state and nothing else, never cached", async () => {
    const response = health({
      feedHealth: "offline",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", feed: "offline" });
  });
});
