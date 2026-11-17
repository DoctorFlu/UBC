import { afterEach, describe, expect, it, vi } from "vitest";

import { health } from "./health";

const service = { feedHealth: "offline" as const };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("answers ok with the feed state and the Gemini environment, and nothing else, never cached", async () => {
    const response = health(service, () => ({ environment: "sandbox" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", feed: "offline", marketEnvironment: "sandbox" });
  });

  it("is unhealthy while the Gemini settings contradict each other, and keeps the reason in the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = health(service, () => {
      throw new Error(
        "GEMINI_API_URL is https://api.gemini.com, but EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox ...",
      );
    });
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("market_data_misconfigured");
    expect(body).not.toContain("api.gemini.com");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_URL is https://api.gemini.com"));
  });
});
