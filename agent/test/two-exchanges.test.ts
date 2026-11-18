import { GEMINI_HOSTS } from "@mandate/gemini";
import {
  DAILY,
  HOSTED_INTENTS,
  HOSTED_WEEKLY_PLAN,
  LISTED,
  TWO_EXCHANGES_AT,
  type TwoExchangeOptions,
  WEEKLY,
  twoExchangeFetch,
} from "@mandate/gemini/two-exchanges";
import { Category } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { createGeminiMarkets } from "../src/markets/gemini";
import { getPortfolio } from "../src/tools/get-portfolio";
import { planHedge } from "../src/tools/plan-hedge";
import { harness } from "./fakes";

/**
 * The agent on a stack whose order venue is Gemini's sandbox, with both exchanges as recorded on
 * 18 November 2026 (`@mandate/gemini/two-exchanges`): what can be added comes from the sandbox's listed
 * strikes only; what is covered comes from the positions held.
 */

type Row = Record<string, unknown>;

const NOW = TWO_EXCHANGES_AT;
const clock = { now: () => new Date(NOW) };

function onSandbox(
  options: {
    holding?: string;
    hosted?: boolean;
    books?: "empty" | "mirrored";
    exchanges?: Omit<TwoExchangeOptions, "sandboxDailyBooks">;
  } = {},
) {
  // The client's own clock: time moves only by what it sleeps, so its rate limiter refills.
  let at = NOW;
  const { fetch, requests } = twoExchangeFetch(() => at, {
    sandboxDailyBooks: options.books ?? "mirrored",
    ...options.exchanges,
  });
  const marketsClient = createGeminiMarkets(
    { baseUrl: GEMINI_HOSTS.sandbox, productionBaseUrl: GEMINI_HOSTS.production },
    {
      fetch,
      now: () => at,
      maxRetries: 0,
      sleep: (ms: number) => {
        at += ms;
        return Promise.resolve();
      },
    },
  );
  const h = harness({
    // The stack's settings for orders on Gemini's sandbox; no credential is read by these tools.
    env: { EXECUTOR_VENUE: "gemini", GEMINI_ENV: "sandbox" },
    marketsClient,
    clock,
    holdings: [{ asset: "BTC", quantity: options.holding ?? "0.05" }],
  });
  if (options.hosted) {
    for (const intent of HOSTED_INTENTS) {
      h.policy.intents.push({
        ...intent,
        market: intent.market ?? "",
        outcome: intent.outcome ?? "NO",
        isBuy: intent.isBuy ?? true,
        amountCents: intent.amountCents ?? 0,
        limitPrice: intent.limitPrice ?? 0,
        category: Category.Crypto,
        proposedAt: Math.floor(NOW / 1000) - 5 * 3_600,
        pnlCents: 0,
      } as (typeof h.policy.intents)[number]);
      // What the chain's events say of it, which is what positions are read from.
      h.policy.views.set(intent.id, {
        id: intent.id,
        status: intent.status,
        reason: intent.status === "rejected" ? "over max trade size" : null,
        market: intent.market,
        category: Category.Crypto,
        outcome: intent.outcome,
        isBuy: intent.isBuy,
        amountCents: intent.amountCents,
        limitPrice: intent.limitPrice,
        agent: null,
        contextHash: null,
        proposedAt: Math.floor(NOW / 1000) - 5 * 3_600,
        filledCents: intent.filledCents ?? null,
        pnlCents: null,
        proposedTxHash: null,
        decidedTxHash: null,
        resultTxHash: null,
      } as unknown as Parameters<typeof h.policy.views.set>[1]);
    }
  }
  return { ...h, requests };
}

const symbolsOf = (structured: Row): string[] =>
  (((structured["plan"] as Row | null)?.["orders"] as Row[] | undefined) ?? []).map(
    (order) => order["instrumentSymbol"] as string,
  );

const sandboxListed = (ticker: typeof WEEKLY | typeof DAILY) =>
  new Set(LISTED.sandbox[ticker].map((strike) => `GEMI-${ticker}-HI${String(strike)}`));

describe("plan_hedge with the sandbox as the order venue", () => {
  it("plans the daily for 0.3 BTC on strikes the sandbox lists, priced from its mirrored book", async () => {
    const h = onSandbox({ holding: "0.3" });
    const { structured, summary } = await planHedge.run(
      {
        asset: "BTC",
        horizon: "daily",
        floorCents: 6_300_000,
        maxCostCents: 2_000,
        requestText: "Protect my 0.3 BTC down to $63,000 today.",
      },
      h.ctx,
    );
    const symbols = symbolsOf(structured);
    expect(symbols.length, summary).toBeGreaterThan(0);
    for (const symbol of symbols) expect(sandboxListed(DAILY).has(symbol), symbol).toBe(true);
  });

  it("never names a strike the sandbox does not list on the weekly, where it lists none below spot", async () => {
    const h = onSandbox({ hosted: true });
    const { structured } = await planHedge.run(
      {
        asset: "BTC",
        horizon: "weekly",
        floorCents: HOSTED_WEEKLY_PLAN.plan.floorCents ?? 0,
        maxCostCents: 6_000,
        requestText: "Is my 0.05 BTC still covered down to the current goal this week?",
      },
      h.ctx,
    );
    for (const symbol of symbolsOf(structured)) expect(sandboxListed(WEEKLY).has(symbol), symbol).toBe(true);
  });

  it("measures the weekly held on production's strikes as covered, and buys nothing", async () => {
    const h = onSandbox({ hosted: true });
    const { structured } = await planHedge.run(
      {
        asset: "BTC",
        eventTicker: WEEKLY,
        floorCents: HOSTED_WEEKLY_PLAN.plan.floorCents ?? 0,
        maxCostCents: 6_000,
        requestText: "Protect my 0.05 BTC this week.",
      },
      h.ctx,
    );
    expect(symbolsOf(structured)).toEqual([]);
    expect((structured["plan"] as Row)["cover"]).toMatchObject({
      state: "met",
      targetPayoutCents: 18_308,
      heldPayoutCents: 24_763,
    });
  });

  it("refuses a ladder the sandbox does not list, and never plans it on production's strikes", async () => {
    const h = onSandbox({ hosted: true, exchanges: { sandboxUnlisted: [WEEKLY] } });
    const { structured, summary } = await planHedge.run(
      {
        asset: "BTC",
        eventTicker: WEEKLY,
        floorCents: HOSTED_WEEKLY_PLAN.plan.floorCents ?? 0,
        maxCostCents: 6_000,
        requestText: "Protect my 0.05 BTC this week.",
      },
      h.ctx,
    );
    expect(structured["plan"] ?? null).toBeNull();
    expect((structured["reasons"] as Row[])[0]).toMatchObject({ code: "LADDER_NOT_LISTED" });
    expect(summary).toContain(
      "Nothing can be bought for BTC2611202200 now: the exchange that takes this mandate's orders (Gemini's sandbox) does not list this ladder.",
    );
    // Production was asked which strikes it lists, and for nothing it would price or fill.
    expect(h.requests.filter((r) => r.startsWith("production /v1/book/"))).toEqual([]);
  });

  it("with BTC through the floor, buys nothing and says what the contracts held pay", async () => {
    const h = onSandbox({ hosted: true, exchanges: { spotUsd: 57_000 } });
    const { structured, summary } = await planHedge.run(
      {
        asset: "BTC",
        eventTicker: WEEKLY,
        floorCents: HOSTED_WEEKLY_PLAN.plan.floorCents ?? 0,
        maxCostCents: 6_000,
        requestText: "Protect my 0.05 BTC this week.",
      },
      h.ctx,
    );
    expect(symbolsOf(structured)).toEqual([]);
    expect(summary).toContain("at or below the floor");
    expect(summary).toContain("$247.63");
    expect(summary).not.toContain("nothing to protect");
  });
});

describe("get_portfolio for each cause", () => {
  const goal = {
    asset: "BTC",
    eventTicker: WEEKLY,
    expiresAt: HOSTED_WEEKLY_PLAN.plan.expiry,
    planId: HOSTED_WEEKLY_PLAN.plan_id,
    floorCents: 5_799_180,
    spotCents: 6_469_037,
    missingBelowVenue: false,
    measuredBelowCents: null,
    targetPayoutCents: 0,
    heldPayoutCents: 0,
    heldByState: { filledCents: 0, awaitingFillCents: 0, awaitingOwnerCents: 0 },
    coverBps: null,
    missingPayoutCents: 0,
    belowFloor: null,
  };
  const head =
    "Cover now: BTC, through Fri 20 Nov (protect below $57,991.80; ladder BTC2611202200, settles Fri Nov 20, 2026, 5:00 PM ET): ";

  it.each([
    [
      "cannot_hedge",
      "no_strike_below_spot",
      "not covered, and nothing can be bought for it on this ladder now: the exchange that takes this mandate's orders lists no strike below today's price, and no position held pays below it.",
    ],
    [
      "cannot_hedge",
      "ladder_not_listed",
      "not covered, and nothing can be bought for it now: the exchange that takes this mandate's orders does not list this ladder, and no position is held on it.",
    ],
    [
      "cannot_hedge",
      "holding_too_small",
      "not covered: the holding is too small for the smallest contract (0.01).",
    ],
    [
      "nothing_to_cover",
      "floor_not_below_ceiling",
      "nothing to protect now: the floor is not below today's price, so the goal calls for no contracts.",
    ],
  ] as const)("says %s (%s) in its own words, never covered", async (state, reason, sentence) => {
    const h = harness({ clock, cover: () => [{ ...goal, state, reason }] });
    const { structured, summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(`${head}${sentence}`);
    expect((structured["cover"] as Row[])[0]).toMatchObject({ state, reason });
  });

  it("says when part of the goal is held and the venue can add nothing", async () => {
    const h = harness({
      clock,
      cover: () => [
        {
          ...goal,
          state: "partly_met",
          reason: "no_strike_below_spot",
          measuredBelowCents: 6_100_000,
          targetPayoutCents: 18_308,
          heldPayoutCents: 8_268,
          heldByState: { filledCents: 8_268, awaitingFillCents: 0, awaitingOwnerCents: 0 },
          coverBps: 4_516,
          missingPayoutCents: 10_040,
        },
      ],
    });
    const { summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(
      `${head}covered 45% (positions pay $82.68 of $183.08), $100.40 missing; the goal protects only down to $61,000.00, the lowest strike there is (the floor $57,991.80 is below every strike); nothing more can be bought for it now: the exchange that takes this mandate's orders lists no strike below today's price.`,
    );
  });

  it("says where a met goal's protection ends when every strike is above the floor", async () => {
    // The hosted weekly at the recording: met, its staircase ending at $61,000, above the $57,991.80 floor.
    const h = harness({
      clock,
      cover: () => [
        {
          ...goal,
          state: "met",
          reason: null,
          measuredBelowCents: 6_100_000,
          targetPayoutCents: 18_308,
          heldPayoutCents: 24_763,
          heldByState: { filledCents: 24_763, awaitingFillCents: 0, awaitingOwnerCents: 0 },
          coverBps: 13_525,
          missingPayoutCents: 0,
        },
      ],
    });
    const { structured, summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(
      `${head}covered, the goal is met (positions pay $247.63 of $183.08); the goal protects only down to $61,000.00, the lowest strike there is (the floor $57,991.80 is below every strike). No lower strike is listed, so nothing more can be added.`,
    );
    expect((structured["cover"] as Row[])[0]).toMatchObject({
      goal: "BTC, through Fri 20 Nov",
      downToCents: 6_100_000,
      floorCents: 5_799_180,
    });
  });

  it("says the real exchange lists lower strikes than the sandbox when the missing part lies there", async () => {
    const h = harness({
      clock,
      cover: () => [
        {
          ...goal,
          floorCents: 6_300_000,
          state: "partly_met",
          reason: "no_more_strikes",
          missingBelowVenue: true,
          measuredBelowCents: 6_300_000,
          targetPayoutCents: 8_300,
          heldPayoutCents: 3_300,
          heldByState: { filledCents: 3_300, awaitingFillCents: 0, awaitingOwnerCents: 0 },
          coverBps: 3_975,
          missingPayoutCents: 5_000,
        },
      ],
    });
    const { summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(
      "covered 39% (positions pay $33.00 of $83.00), $50.00 missing; nothing more can be bought for it now: Gemini's real exchange lists lower strikes that the sandbox, the exchange that takes this mandate's orders, does not, and what is missing lies on those.",
    );
  });

  it("with BTC through the floor, says what the positions held pay against the goal as planned", async () => {
    // What the console measures for the hosted weekly at $57,000 (dashboard cover-two-exchanges test).
    const h = harness({
      clock,
      cover: () => [
        {
          ...goal,
          state: "met",
          reason: null,
          spotCents: 5_700_000,
          measuredBelowCents: 6_100_000,
          targetPayoutCents: 17_176,
          heldPayoutCents: 24_763,
          heldByState: { filledCents: 24_763, awaitingFillCents: 0, awaitingOwnerCents: 0 },
          coverBps: 14_417,
          missingPayoutCents: 0,
          belowFloor: { plannedSpotCents: 6_443_533, paysAtSpotCents: 24_763 },
        },
      ],
    });
    const { structured, summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(
      `${head}covered: BTC is at or below the floor, at $57,000.00; if it settles there, positions pay $247.63, against the $171.76 the goal protects from $64,435.33, the price when it was planned, down to $61,000.00.`,
    );
    expect(summary).not.toContain("not covered");
    expect((structured["cover"] as Row[])[0]).toMatchObject({
      state: "met",
      belowFloor: { spotCents: 5_700_000, plannedSpotCents: 6_443_533, downToCents: 6_100_000 },
    });
  });
});
