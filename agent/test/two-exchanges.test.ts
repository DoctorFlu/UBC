import { GEMINI_HOSTS } from "@mandate/gemini";
import {
  DAILY,
  HOSTED_INTENTS,
  HOSTED_WEEKLY_PLAN,
  LISTED,
  TWO_EXCHANGES_AT,
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

function onSandbox(options: { holding?: string; hosted?: boolean; books?: "empty" | "mirrored" } = {}) {
  // The client's own clock: time moves only by what it sleeps, so its rate limiter refills.
  let at = NOW;
  const { fetch } = twoExchangeFetch(() => at, { sandboxDailyBooks: options.books ?? "mirrored" });
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
    }
  }
  return h;
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
});

describe("get_portfolio for a goal without a staircase", () => {
  const goal = {
    asset: "BTC",
    eventTicker: WEEKLY,
    expiresAt: HOSTED_WEEKLY_PLAN.plan.expiry,
    planId: HOSTED_WEEKLY_PLAN.plan_id,
    floorCents: 5_799_180,
    spotCents: 6_469_037,
    measuredBelowCents: null,
    targetPayoutCents: 0,
    heldPayoutCents: 0,
    heldByState: { filledCents: 0, awaitingFillCents: 0, awaitingOwnerCents: 0 },
    coverBps: null,
    missingPayoutCents: 0,
  };
  const head = "Cover now: BTC below $57,991.80 on BTC2611202200 (settles Fri Nov 20, 2026, 5:00 PM ET): ";

  it.each([
    [
      "cannot_hedge",
      "no_strike_below_spot",
      "not covered, and nothing can be bought for it on this ladder now: the exchange orders go to lists no strike below today's price, and no position held pays below it.",
    ],
    [
      "cannot_hedge",
      "ladder_not_listed",
      "not covered, and nothing can be bought for it now: the exchange orders go to does not list this ladder, and no position is held on it.",
    ],
    [
      "cannot_hedge",
      "holding_too_small",
      "not covered: the holding is too small for the smallest contract (0.01).",
    ],
    [
      "nothing_to_cover",
      "floor_not_below_ceiling",
      "not covered, and nothing to protect now: the floor is not below today's price, so the goal calls for no contracts.",
    ],
  ] as const)("says %s (%s) in its own words, never covered", async (state, reason, sentence) => {
    const h = harness({ clock, cover: () => [{ ...goal, state, reason }] });
    const { structured, summary } = await getPortfolio.run({}, h.ctx);
    expect(summary).toContain(`${head}${sentence}`);
    expect((structured["cover"] as Row[])[0]).toMatchObject({ state, reason });
  });
});
