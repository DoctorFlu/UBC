/**
 * The simulated venue reads outcomes from Gemini's public data exactly as Gemini publishes them: these
 * tests use a settled weekly BTC ladder and an open one, both recorded from Gemini's public API.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eventSchema, GeminiError, normalizeEvent, type MarketEvent } from "@mandate/gemini";
import type { PutSettlementRequest } from "@mandate/shared";
import { consoleSettlementSink, simulatedVenue, type HeldPosition } from "../src";

const FIXTURES = fileURLToPath(new URL("../../gemini/test/fixtures/", import.meta.url));

function recorded(file: string): MarketEvent {
  return normalizeEvent(eventSchema.parse(JSON.parse(readFileSync(`${FIXTURES}${file}`, "utf8"))));
}

/** BTC2611132200 settled at $68,332.87: strikes up to $68,000 resolved YES, $68,500 and up resolved NO. */
const SETTLED = recorded("event-BTC2611132200-settled.json");
const OPEN = recorded("event-BTC2611202200.json");

function venueAt(nowIso: string, events: MarketEvent[] = [SETTLED, OPEN]) {
  return simulatedVenue(
    {
      getEvent: (ticker) => {
        const event = events.find((candidate) => candidate.ticker === ticker);
        return event
          ? Promise.resolve(event)
          : Promise.reject(new GeminiError("not_found", `no event ${ticker}`, { status: 404 }));
      },
    },
    { now: () => Date.parse(nowIso) },
  );
}

const position = (market: string, patch: Partial<HeldPosition> = {}): HeldPosition => ({
  intentId: 7,
  market,
  outcome: "NO",
  costCents: 1_240,
  limitPrice: 31,
  ...patch,
});

describe("the simulated venue's outcomes", () => {
  it("pays NO contracts on a strike the price ended below, one cent per hundredth", async () => {
    const outcome = await venueAt("2026-11-17T00:00:00Z").positionOutcome(
      position("GEMI-BTC2611132200-HI68500"),
    );
    expect(outcome).toEqual({
      status: "resolved",
      eventTicker: "BTC2611132200",
      strikeCents: 6_850_000,
      expiresAt: "2026-11-13T22:00:00.000Z",
      resolution: "no",
      resolvedAt: "2026-11-13T22:00:09.103Z",
      settlementValue: "68332.8725",
      contractsHundredths: 4_000,
      payoutCents: 4_000,
    });
  });

  it("pays nothing on a strike the price ended above, and YES contracts there pay", async () => {
    const venue = venueAt("2026-11-17T00:00:00Z");
    expect(await venue.positionOutcome(position("GEMI-BTC2611132200-HI68000"))).toMatchObject({
      status: "resolved",
      resolution: "yes",
      contractsHundredths: 4_000,
      payoutCents: 0,
    });
    expect(
      await venue.positionOutcome(position("GEMI-BTC2611132200-HI68000", { outcome: "YES", limitPrice: 80 })),
    ).toMatchObject({ resolution: "yes", contractsHundredths: 1_550, payoutCents: 1_550 });
  });

  it("says when an open market expires, and waits after expiry until Gemini publishes the outcome", async () => {
    const market = "GEMI-BTC2611202200-HI65000";
    expect(await venueAt("2026-11-17T00:00:00Z").positionOutcome(position(market))).toEqual({
      status: "open",
      expiresAt: "2026-11-20T22:00:00.000Z",
    });
    // Past the expiry, the recording still says nothing about the outcome: never guess one.
    expect(await venueAt("2026-11-20T22:00:01Z").positionOutcome(position(market))).toEqual({
      status: "awaiting",
      expiresAt: "2026-11-20T22:00:00.000Z",
    });
  });

  it("reports a market Gemini does not list, and throws when Gemini cannot be reached", async () => {
    expect(await venueAt("2026-11-17T00:00:00Z").positionOutcome(position("GEMI-NOPE2611202200-X"))).toEqual({
      status: "unlisted",
    });
    const down = simulatedVenue({ getEvent: () => Promise.reject(new GeminiError("network", "down")) });
    await expect(down.positionOutcome(position("GEMI-BTC2611202200-HI65000"))).rejects.toThrow("down");
  });

  it("fills every order in full at once, and places nothing", async () => {
    const venue = venueAt("2026-11-17T00:00:00Z");
    const order = {
      intentId: 3,
      market: "GEMI-BTC2611202200-HI65000",
      outcome: "NO" as const,
      isBuy: true,
      amountCents: 1_240,
      limitPrice: 31,
    };
    const placement = await venue.placeOrder(order);
    if (placement.status !== "placed") throw new Error("the simulated venue places every order");
    expect(await venue.readFill(placement.placed)).toEqual({
      state: "closed",
      filledCents: 1_240,
      detail: "simulated full fill",
    });
  });
});

describe("the console as the settlement sink", () => {
  const request: PutSettlementRequest = {
    document: {
      version: 1,
      chainId: 31337,
      policy: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      intentId: 4,
      market: "GEMI-BTC2611132200-HI68500",
      eventTicker: "BTC2611132200",
      strikeCents: 6_850_000,
      expiresAt: "2026-11-13T22:00:00.000Z",
      outcome: "NO",
      costCents: 1_240,
      limitPrice: 31,
      contractsHundredths: 4_000,
      resolution: "no",
      payoutCents: 4_000,
      pnlCents: 2_760,
      settlementValue: "68332.8725",
      resolvedAt: "2026-11-13T22:00:12.185Z",
      venue: "simulated",
    },
    signature: `0x${"ab".repeat(65)}`,
  };

  function sinkAnswering(status: number, body: unknown = {}) {
    const sent: { url: string; init: RequestInit }[] = [];
    const sink = consoleSettlementSink({
      consoleUrl: "http://console.test/",
      fetch: (url, init) => {
        sent.push({ url, init });
        return Promise.resolve(Response.json(body, { status }));
      },
    });
    return { sink, sent };
  }

  it("PUTs the signed record under its intent id, and tells stored from already stored", async () => {
    const created = sinkAnswering(201);
    expect(await created.sink.record(request)).toEqual({ status: "stored" });
    expect(created.sent[0]?.url).toBe("http://console.test/api/executor/v1/settlements/4");
    expect(created.sent[0]?.init.method).toBe("PUT");
    expect(JSON.parse(created.sent[0]?.init.body as string)).toEqual(request);
    expect(await sinkAnswering(200).sink.record(request)).toEqual({ status: "duplicate" });
  });

  it("keeps the first record on a conflict, and tries again on anything else", async () => {
    const error = (code: string) => ({ error: { code, message: "said the console" } });
    expect(await sinkAnswering(409, error("conflict")).sink.record(request)).toEqual({
      status: "conflict",
      detail: "conflict: said the console",
    });
    expect(await sinkAnswering(409, error("not_executed")).sink.record(request)).toMatchObject({
      status: "retry",
    });
    expect(await sinkAnswering(503, error("chain_unavailable")).sink.record(request)).toMatchObject({
      status: "retry",
    });
    const unreachable = consoleSettlementSink({
      consoleUrl: "http://console.test",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await unreachable.record(request)).toEqual({
      status: "retry",
      detail: "the console at http://console.test did not answer (fetch failed)",
    });
  });
});
