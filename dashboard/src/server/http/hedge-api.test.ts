import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planHedge } from "@mandate/planner";
import { Category, type PolicyRules, categoryMask } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import type { HedgeMarketResponse } from "@/lib/hedge/types";

import { RECORDED_EVENT, recordedResponse } from "../../../e2e/support/fake-gemini";
import type { ConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { previewPlan } from "../market/preview";
import { MarketQuotes } from "../market/quotes";
import { getHedgeMarket } from "./hedge-api";

/** When the Gemini fixtures were recorded: the recorded weekly ladder is the soonest one then. */
const NOW = Date.parse("2026-11-15T20:19:00Z");
const silent = { info: () => undefined, warn: () => undefined };

function makeService(): ConsoleService {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-hedge-"));
  const config: ConsoleConfig = {
    dataDir,
    eventSource: "rpc",
    pollIntervalMs: 50,
    serviceToken: "hedge-test-token-0123456789abcdef",
    streamSecurityToken: null,
    publicUrl: "http://console.test",
    mcpPublicUrl: null,
  };
  return new ConsoleService(config, openDatabase(dataDir), {
    env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
    logger: silent,
  });
}

/** A stand-in for Gemini's public API that answers from the recorded fixtures, or fails on demand. */
function fakeGemini() {
  const state = { failing: false, requests: [] as string[] };
  const fetch = (input: string): Promise<Response> => {
    const url = new URL(input);
    const path = `${url.pathname}${url.search}`;
    state.requests.push(path);
    if (state.failing) return Promise.resolve(new Response("{}", { status: 503 }));
    const body = recordedResponse(path, NOW);
    return Promise.resolve(
      body === null ? new Response("{}", { status: 404 }) : Response.json(body, { status: 200 }),
    );
  };
  return { state, fetch };
}

function quotesFor(gemini: ReturnType<typeof fakeGemini>, clock = { now: NOW }) {
  return new MarketQuotes({
    baseUrl: "https://gemini.test",
    fetch: gemini.fetch,
    now: () => clock.now,
    // The Gemini client's rate limiter waits on this clock: waiting moves it, at once.
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
}

const get = (query: string) => new Request(`http://console.test/api/console/hedge/market?${query}`);

async function read(response: Response): Promise<HedgeMarketResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as HedgeMarketResponse;
}

const RULES: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

describe("GET /api/console/hedge/market", () => {
  it("refuses an asset Gemini does not list, without asking Gemini", async () => {
    const service = makeService();
    const gemini = fakeGemini();
    const quotes = quotesFor(gemini);
    for (const asset of ["bitcoin!", "DOGE", "AAAA", ""]) {
      const response = await getHedgeMarket(get(`asset=${encodeURIComponent(asset)}`), service, quotes);
      expect(response.status).toBe(422);
    }
    expect(gemini.state.requests).toEqual([]);
    expect(quotes.size).toBe(0);
  });

  it("refuses any event but the stored plan's, without asking Gemini", async () => {
    const service = makeService();
    const gemini = fakeGemini();
    const quotes = quotesFor(gemini);
    // No plan stored: no event is acceptable, not even a real one.
    expect((await getHedgeMarket(get(`asset=BTC&event=${RECORDED_EVENT}`), service, quotes)).status).toBe(
      422,
    );
    for (let index = 0; index < 50; index += 1) {
      const response = await getHedgeMarket(
        get(`asset=BTC&event=BTC26112022${index.toString()}`),
        service,
        quotes,
      );
      expect(response.status).toBe(422);
    }
    expect(gemini.state.requests).toEqual([]);
    expect(quotes.size).toBe(0);
  });

  it("answers live quotes, highest strike first, and says why there is no preview", async () => {
    const service = makeService();
    const body = await read(
      await getHedgeMarket(get("asset=btc&preview=1"), service, quotesFor(fakeGemini())),
    );
    expect(body.asset).toBe("BTC");
    expect(body.error).toBeNull();
    expect(body.quotes?.eventTicker).toBe(RECORDED_EVENT);
    const strikes = body.quotes?.rungs.map((rung) => rung.strikeCents) ?? [];
    expect(strikes.length).toBeGreaterThan(3);
    expect(strikes).toEqual([...strikes].sort((a, b) => b - a));
    expect(body.preview).toEqual({
      status: "unavailable",
      reason: "Save your BTC holding to see a preview.",
    });

    service.offchain.saveHoldings([{ asset: "BTC", quantity: "0.05" }]);
    service.changed();
    const withHolding = await read(
      await getHedgeMarket(get("asset=BTC&preview=1"), service, quotesFor(fakeGemini())),
    );
    expect(withHolding.preview).toEqual({
      status: "unavailable",
      reason: "Sign a mandate first: a hedge has to fit its limits.",
    });
  });

  it("asks for the agent plan's event and makes no preview once the agent has planned", async () => {
    const service = makeService();
    const gemini = fakeGemini();
    const quotes = quotesFor(gemini);
    const ladder = await quotes.ladder("BTC", null);
    if (!ladder.ok) throw new Error("the recorded ladder did not load");
    const plan = planHedge({
      holding: { asset: "BTC", quantity: "0.05" },
      ladder: ladder.ladder,
      goal: { dropPercent: 5 },
      maxCostCents: 5_000,
      limits: { maxTradeCents: 2_500, remainingBudgetCents: 20_000, categoryAllowed: true },
    });
    service.offchain.putPlan({
      planId: plan.planId,
      asset: "BTC",
      requestText: "Protect my BTC",
      createdAt: "2026-11-15T20:20:00.000Z",
      plan: plan as unknown as Record<string, unknown>,
    });
    service.changed();
    expect(service.snapshot().offchain.plans).toEqual([
      expect.objectContaining({ planId: plan.planId, asset: "BTC", plan }),
    ]);

    // A fresh client, so nothing comes from the Gemini client's own cache.
    gemini.state.requests.length = 0;
    const body = await read(await getHedgeMarket(get("asset=BTC&preview=1"), service, quotesFor(gemini)));
    expect(body.eventTicker).toBe(plan.eventTicker);
    expect(body.preview).toEqual({ status: "not_requested" });
    expect(gemini.state.requests.some((path) => path.includes(`/events/${plan.eventTicker}`))).toBe(true);

    // Naming the stored plan's event is accepted; any other is not.
    const named = await getHedgeMarket(get(`asset=BTC&event=${plan.eventTicker}`), service, quotes);
    expect(named.status).toBe(200);
    expect((await getHedgeMarket(get("asset=BTC&event=ETH2611202200"), service, quotes)).status).toBe(422);
  });

  it("reports Gemini being down as part of the answer, and caches the failure briefly", async () => {
    const service = makeService();
    const gemini = fakeGemini();
    gemini.state.failing = true;
    const clock = { now: NOW };
    const quotes = quotesFor(gemini, clock);
    const body = await read(await getHedgeMarket(get("asset=BTC&preview=1"), service, quotes));
    expect(body.quotes).toBeNull();
    expect(body.error).toMatchObject({ code: "unreachable" });
    expect(body.preview).toMatchObject({ status: "unavailable" });

    const asked = gemini.state.requests.length;
    await getHedgeMarket(get("asset=BTC"), service, quotes);
    expect(gemini.state.requests.length).toBe(asked);

    gemini.state.failing = false;
    clock.now += 6_000;
    const recovered = await read(await getHedgeMarket(get("asset=BTC"), service, quotes));
    expect(recovered.error).toBeNull();
    expect(recovered.quotes?.eventTicker).toBe(RECORDED_EVENT);
  });

  it("keeps at most its cap of ladders, dropping expired ones first and then the oldest", async () => {
    const gemini = fakeGemini();
    const clock = { now: NOW };
    const quotes = new MarketQuotes({
      baseUrl: "https://gemini.test",
      fetch: gemini.fetch,
      now: () => clock.now,
      sleep: (ms) => {
        clock.now += ms;
        return Promise.resolve();
      },
      maxEntries: 3,
    });
    // Unknown events fail at Gemini (404), which is enough to fill the cache with distinct keys.
    for (const event of ["E1", "E2", "E3", "E4", "E5"]) await quotes.ladder("BTC", event);
    expect(quotes.size).toBe(3);
    const asked = gemini.state.requests.length;
    await quotes.ladder("BTC", "E5");
    expect(gemini.state.requests.length).toBe(asked);
    await quotes.ladder("BTC", "E1");
    expect(gemini.state.requests.length).toBeGreaterThan(asked);
    expect(quotes.size).toBe(3);

    // Once everything has expired, a new key leaves only itself.
    clock.now += 60_000;
    await quotes.ladder("BTC", null);
    expect(quotes.size).toBe(1);
  });

  it("says what each listing lookup cost: every candidate tried, retries included, nothing when cached", async () => {
    const gemini = fakeGemini();
    const quotes = quotesFor(gemini);
    expect(await quotes.marketCategory(`GEMI-${RECORDED_EVENT}-HI61000`)).toEqual({
      category: Category.Crypto,
      requests: 1,
    });
    // The event is in the client's cache now: another market on it costs nothing.
    expect(await quotes.marketCategory(`GEMI-${RECORDED_EVENT}-HI61500`)).toEqual({
      category: Category.Crypto,
      requests: 0,
    });
    // An invented symbol misses every candidate ticker.
    expect(await quotes.marketCategory("GEMI-JUNK-A-B-C-X")).toEqual({ category: null, requests: 4 });
    gemini.state.failing = true;
    const before = gemini.state.requests.length;
    await expect(quotes.marketCategory("GEMI-DOWN2611202200-X")).rejects.toThrow();
    expect(gemini.state.requests.length - before).toBe(MarketQuotes.ATTEMPTS_PER_REQUEST);
  });

  it("shares one Gemini request between callers inside the cache window", async () => {
    const gemini = fakeGemini();
    const quotes = quotesFor(gemini);
    await Promise.all([quotes.ladder("BTC", null), quotes.ladder("BTC", null), quotes.ladder("BTC", null)]);
    const asked = gemini.state.requests.length;
    await quotes.ladder("BTC", null);
    expect(gemini.state.requests.length).toBe(asked);
  });
});

describe("previewPlan", () => {
  it("is exactly the planner's plan for the holding, the mandate's limits and the remaining budget", async () => {
    const lookup = await quotesFor(fakeGemini()).ladder("BTC", null);
    if (!lookup.ok) throw new Error("the recorded ladder did not load");
    const preview = previewPlan({
      asset: "BTC",
      holdings: [{ asset: "BTC", quantity: "0.05" }],
      rules: RULES,
      committedCents: 4_000,
      ladder: lookup.ladder,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan).toEqual(
      planHedge({
        holding: { asset: "BTC", quantity: "0.05" },
        ladder: lookup.ladder,
        goal: { dropPercent: 10 },
        maxCostCents: 16_000,
        limits: { maxTradeCents: 2_500, remainingBudgetCents: 16_000, categoryAllowed: true },
      }),
    );
    expect(preview.assumptions).toMatchObject({ remainingBudgetCents: 16_000, dropPercent: 10 });
  });

  it("says why there is no preview when the budget is spent", async () => {
    const lookup = await quotesFor(fakeGemini()).ladder("BTC", null);
    if (!lookup.ok) throw new Error("the recorded ladder did not load");
    const preview = previewPlan({
      asset: "BTC",
      holdings: [{ asset: "BTC", quantity: "0.05" }],
      rules: RULES,
      committedCents: 20_000,
      ladder: lookup.ladder,
    });
    expect(preview).toEqual({
      status: "unavailable",
      reason: "The mandate's budget is fully committed ($200.00), so no hedge fits.",
    });
  });
});
