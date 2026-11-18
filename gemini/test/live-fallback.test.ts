/**
 * The suites' fallback when live Gemini is unavailable (Gemini's scheduled maintenance, 18 November 2026,
 * 05:00 to about 07:00 UTC): the check that tells Gemini's failures from ours, and the recorded ladder the
 * suites run on instead.
 */
import { describe, expect, it } from "vitest";
import { createGeminiClient, GeminiError, type GeminiClient } from "../src/index";
import {
  bannerLine,
  checkLiveGemini,
  maintenanceInProgress,
  RECORDED_EXIT_CODE,
} from "../testing/live-gemini";
import { RECORDED_EVENT, recordedResponse, startRecordedGemini } from "../testing/recorded-public";

const ladders = [{ eventTicker: "BTC2611182200" }];
const spot = { midCents: 6_435_000 };

function client(failure: GeminiError | null): Pick<GeminiClient, "listLadders" | "getSpot"> {
  return {
    listLadders: () => (failure ? Promise.reject(failure) : Promise.resolve(ladders as never)),
    getSpot: () => Promise.resolve(spot as never),
  };
}

describe("checkLiveGemini", () => {
  it("says live Gemini is available when it answers", async () => {
    expect(await checkLiveGemini({ client: client(null), maintenance: () => Promise.resolve(null) })).toEqual(
      {
        available: true,
      },
    );
  });

  it("calls a 500 Gemini's failure, naming the maintenance its status page reports", async () => {
    const live = await checkLiveGemini({
      client: client(new GeminiError("http", "returned HTTP 500", { status: 500 })),
      maintenance: () => Promise.resolve("Scheduled Maintenance - Full Exchange Maintenance"),
    });
    expect(live).toMatchObject({ available: false });
    if (live.available) throw new Error("expected unavailable");
    expect(live.reason).toMatch(
      /^Gemini production answered HTTP 500 at \d\d:\d\d:\d\d UTC; Gemini's status page reports "Scheduled Maintenance - Full Exchange Maintenance" in progress$/,
    );
    expect(bannerLine("ran on the recorded ladder", live.reason)).toMatch(
      /^LIVE GEMINI UNAVAILABLE: ran on the recorded ladder because Gemini production answered HTTP 500 at /,
    );
  });

  it("says nothing about the cause when the status page reports none", async () => {
    const live = await checkLiveGemini({
      client: client(new GeminiError("timeout", "timed out")),
      maintenance: () => Promise.resolve(null),
    });
    expect(live).toEqual({
      available: false,
      reason: expect.stringMatching(/^Gemini production failed \(timeout\) at [\d:]+ UTC$/) as unknown,
    });
  });

  it("fails the step on anything that may be ours: a 4xx or an answer we cannot read", async () => {
    await expect(
      checkLiveGemini({ client: client(new GeminiError("http", "returned HTTP 400", { status: 400 })) }),
    ).rejects.toThrow("returned HTTP 400");
    await expect(
      checkLiveGemini({ client: client(new GeminiError("invalid_response", "unreadable")) }),
    ).rejects.toThrow("unreadable");
  });

  it("reads the status page's maintenance only from an answer that lists one in progress", async () => {
    const page =
      (body: unknown, status = 200) =>
      () =>
        Promise.resolve(Response.json(body, { status }));
    expect(
      await maintenanceInProgress(
        page({ scheduled_maintenances: [{ name: "Full Exchange Maintenance", status: "in_progress" }] }),
      ),
    ).toBe("Full Exchange Maintenance");
    expect(
      await maintenanceInProgress(page({ scheduled_maintenances: [{ name: "Later", status: "scheduled" }] })),
    ).toBeNull();
    expect(await maintenanceInProgress(page({}, 503))).toBeNull();
    expect(await maintenanceInProgress(() => Promise.reject(new Error("offline")))).toBeNull();
  });

  it("exits with a status no failure of ours uses", () => {
    expect(RECORDED_EXIT_CODE).toBe(3);
  });
});

describe("the recorded Gemini", () => {
  it("serves a weekly ladder whose expiry is still ahead, with books, through the real client", async () => {
    const server = await startRecordedGemini();
    try {
      const gemini = createGeminiClient({ baseUrl: server.url, maxRetries: 0 });
      const ladder = await gemini.getLadder({ asset: "BTC", horizon: "weekly", depth: "below-spot" });
      expect(ladder.eventTicker).toBe(RECORDED_EVENT);
      expect(Date.parse(ladder.expiry)).toBeGreaterThan(Date.now());
      expect(ladder.rungs.some((rung) => rung.depth !== undefined)).toBe(true);
      expect(server.requests.some((path) => path.startsWith("/v1/book/"))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("answers books only when asked to, as the console's suites expect", () => {
    const book = `/v1/book/GEMI-${RECORDED_EVENT}-HI64000`;
    expect(recordedResponse(book)).toBeNull();
    expect(recordedResponse(book, Date.now(), { books: true })).not.toBeNull();
  });
});
