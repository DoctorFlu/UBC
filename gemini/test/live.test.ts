/**
 * Smoke test against the real public API. Skipped unless LIVE=1:
 *
 *   LIVE=1 npx vitest run gemini/test/live.test.ts
 */
import { describe, expect, it } from "vitest";
import { createGeminiClient } from "../src/index";

describe.skipIf(process.env["LIVE"] !== "1")("live Gemini API", () => {
  it("returns a sorted BTC ladder with spot and depth", async () => {
    const client = createGeminiClient();
    const ladders = await client.listLadders("BTC");
    expect(ladders.length).toBeGreaterThan(0);
    const listing = ladders.find((l) => l.kind === "weekly") ?? ladders.at(-1);
    if (listing === undefined) throw new Error("no BTC ladders");
    const ladder = await client.getLadder({
      asset: "BTC",
      eventTicker: listing.eventTicker,
      depth: "below-spot",
    });
    expect(ladder.spot.midCents).toBeGreaterThan(0);
    expect(ladder.rungs.length).toBeGreaterThan(0);
    const strikes = ladder.rungs.map((r) => r.strikeCents);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    expect(ladder.rungs.some((r) => r.depth !== undefined)).toBe(true);
  }, 60_000);
});
