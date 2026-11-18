import { GEMINI_HOSTS } from "@mandate/gemini";
import {
  HOSTED_HOLDING,
  HOSTED_INTENTS,
  HOSTED_WEEKLY_PLAN,
  TWO_EXCHANGES_AT,
  type TwoExchangeOptions,
  WEEKLY,
  twoExchangeFetch,
} from "@mandate/gemini/two-exchanges";
import type { IntentView } from "@mandate/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coverNow, coverSentence } from "@/features/hedge/cover-now";
import type { AgentPlanView } from "@/lib/hedge/types";
import type { ConsoleSnapshot } from "@/lib/live/types";

import type { Access } from "./accounts/accounts";
import type { ConsoleService } from "./console-service";
import { coverOfSnapshot } from "./cover-summary";
import { MarketQuotes, ladderQuotes } from "./market/quotes";
import type { LadderSource } from "./wake";
import { workspaceHome } from "./workspace-home";

/**
 * Cover on a stack whose order venue lists other strikes than production (the hosted switch to Gemini's
 * sandbox, 18 November 2026): the weekly goal's positions were bought on strikes only production lists.
 * What is covered comes from the positions held, each resolved on its own exchange, never from the order
 * venue's strike list alone.
 */

const NOW = TWO_EXCHANGES_AT;

function quotesOn(venue: "production" | "sandbox", options: TwoExchangeOptions = {}): LadderSource {
  // The client's clock moves only by what it sleeps, so its rate limiter refills.
  let at = NOW;
  const { fetch } = twoExchangeFetch(() => at, options);
  const quotes = new MarketQuotes({
    baseUrl: GEMINI_HOSTS[venue],
    productionBaseUrl: GEMINI_HOSTS.production,
    fetch,
    now: () => at,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
  });
  return (asset, eventTicker) => quotes.ladder(asset, eventTicker);
}

/** The Hedge page's sentence for a goal, on the sandbox. */
async function hedgeSentence(options: {
  plan?: Partial<AgentPlanView["plan"]>;
  holding?: string;
  intents?: IntentView[];
  exchanges?: TwoExchangeOptions;
}): Promise<{ state: string; reason: string | null; sentence: string }> {
  const lookup = await quotesOn("sandbox", options.exchanges)("BTC", WEEKLY);
  if (!lookup.ok) throw new Error("the sandbox ladder did not answer");
  const cover = coverNow({
    plan: { ...weeklyGoal.plan, ...options.plan },
    holdingQuantity: options.holding ?? HOSTED_HOLDING.quantity,
    quotes: ladderQuotes(lookup.ladder, lookup.elsewhere, lookup.listed),
    intents: options.intents ?? [],
  });
  if (!cover) throw new Error("no cover");
  return {
    state: cover.assessment.state,
    reason: cover.assessment.reason,
    sentence: coverSentence(cover.assessment, "Nov 20, 22:00 UTC"),
  };
}

const weeklyGoal: AgentPlanView = {
  planId: HOSTED_WEEKLY_PLAN.plan_id,
  asset: HOSTED_WEEKLY_PLAN.asset,
  requestText: HOSTED_WEEKLY_PLAN.request_text,
  createdAt: HOSTED_WEEKLY_PLAN.created_at,
  storedAt: HOSTED_WEEKLY_PLAN.stored_at,
  plan: HOSTED_WEEKLY_PLAN.plan as unknown as AgentPlanView["plan"],
};

function intentViews(): IntentView[] {
  return HOSTED_INTENTS.map(
    (intent) =>
      ({
        ...intent,
        reason: intent.status === "rejected" ? "over max trade size" : null,
        category: 1,
        agent: null,
        contextHash: null,
        proposedAt: Math.floor(NOW / 1000) - 3600,
        pnlCents: null,
        proposedTxHash: `0x${intent.id.toString(16).padStart(64, "0")}`,
        decidedTxHash: null,
        resultTxHash: null,
      }) as IntentView,
  );
}

/** One mandate's snapshot: its goals, holding and intents, as the console reads them. */
function snapshot(options: { intents: IntentView[]; plans: AgentPlanView[] }): ConsoleSnapshot {
  return {
    seq: 1,
    contract: null,
    chain: {
      intents: options.intents,
      events: [],
      paused: false,
      committedCents: options.intents.reduce((sum, i) => sum + (i.filledCents ?? 0), 0),
      rules: null,
    },
    offchain: {
      holdings: [HOSTED_HOLDING],
      holdingsUpdatedAt: "2026-11-18T03:10:40.504Z",
      pairing: null,
      changeRequests: [],
      plans: options.plans,
      signalPayments: [],
      signalBudget: null,
    },
  } as unknown as ConsoleSnapshot;
}

describe("cover of the hosted weekly goal, with positions on strikes only production lists", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads covered with production as the order venue (the control: the fixture is faithful)", async () => {
    const [cover] = await coverOfSnapshot(
      snapshot({ intents: intentViews(), plans: [weeklyGoal] }),
      quotesOn("production"),
      NOW,
    );
    expect(cover).toMatchObject({
      eventTicker: WEEKLY,
      state: "met",
      floorCents: 5_799_180,
      measuredBelowCents: 6_100_000,
      heldPayoutCents: 24_763,
    });
  });

  it("reads covered by the same positions with the sandbox as the order venue", async () => {
    const [cover] = await coverOfSnapshot(
      snapshot({ intents: intentViews(), plans: [weeklyGoal] }),
      quotesOn("sandbox"),
      NOW,
    );
    expect(cover).toMatchObject({
      eventTicker: WEEKLY,
      state: "met",
      floorCents: 5_799_180,
      measuredBelowCents: 6_100_000,
      heldPayoutCents: 24_763,
    });
  });

  it("says so on the Hedge page, with the goal's real floor and where its protection ends", async () => {
    const { state, sentence } = await hedgeSentence({ intents: intentViews() });
    // 0.05 BTC x ($64,662 - $61,000): every strike there is lies above the floor, so the staircase ends at $61,000.
    expect(sentence).toBe(
      "Covered. If BTC settles below $61,000 on Nov 20, 22:00 UTC, the contracts you hold pay $247.63, more than the $183.08 your 0.05 BTC loses from today's $64,662 down to $61,000, the lowest strike there is (your floor $57,992 is below every strike). Nothing more is needed.",
    );
    expect(state).toBe("met");
  });

  it("gives each cause without a staircase its own true sentence, never a $0 floor", async () => {
    // Nothing held, and the sandbox lists no strike below spot.
    expect(await hedgeSentence({})).toEqual({
      state: "cannot_hedge",
      reason: "no_strike_below_spot",
      sentence:
        "Not covered, and nothing can be bought for it on this ladder now: it lists no strike below today's BTC price of $64,662, and you hold no contract that pays below it.",
    });
    // The floor is above spot, nothing held.
    expect(await hedgeSentence({ plan: { floorCents: 6_500_000 } })).toEqual({
      state: "nothing_to_cover",
      reason: "floor_not_below_ceiling",
      sentence:
        "Nothing to protect now: the floor $65,000 is not below today's BTC price of $64,662, so the goal calls for no contracts.",
    });
    // A holding too small for one hundredth of a contract.
    expect(await hedgeSentence({ holding: "0.00000001", intents: intentViews() })).toMatchObject({
      state: "cannot_hedge",
      reason: "holding_too_small",
    });
    // The sandbox does not list the weekly at all: positions held are measured on production's strikes.
    const unlisted = { sandboxUnlisted: [WEEKLY] };
    expect(await hedgeSentence({ exchanges: unlisted })).toEqual({
      state: "cannot_hedge",
      reason: "ladder_not_listed",
      sentence:
        "Not covered, and nothing can be bought for it now: the exchange your orders go to does not list this ladder, and you hold no contract on it.",
    });
    expect(await hedgeSentence({ exchanges: unlisted, intents: intentViews() })).toMatchObject({
      state: "met",
      reason: null,
    });
  });

  it("with BTC fallen through the floor, measures the held contracts against the goal as planned", async () => {
    const fallen = { spotUsd: 57_000 };
    // The goal as planned: 0.05 BTC from the plan's $64,435.33 down to $61,000, $171.76 in 0.01 contracts.
    // Every held strike is above $57,000, so all of them pay if it settles there.
    expect(await hedgeSentence({ exchanges: fallen, intents: intentViews() })).toEqual({
      state: "met",
      reason: null,
      sentence:
        "Covered. BTC is at or below the floor: today's $57,000 is not above $57,992. If it settles there on Nov 20, 22:00 UTC, the contracts you hold pay $247.63, more than the $171.76 the goal protects, your 0.05 BTC's fall from $64,435, its price when the goal was set, down to $61,000, the lowest strike there is (your floor $57,992 is below every strike).",
    });
    // Nothing held: nothing to protect, as before.
    expect(await hedgeSentence({ exchanges: fallen })).toEqual({
      state: "nothing_to_cover",
      reason: "floor_not_below_ceiling",
      sentence:
        "Nothing to protect now: the floor $57,992 is not below today's BTC price of $57,000, so the goal calls for no contracts.",
    });
    // Only the top three strikes held: they pay $82.68 of the $171.76.
    const partial = intentViews().filter((intent) => intent.id <= 2);
    expect(await hedgeSentence({ exchanges: fallen, intents: partial })).toMatchObject({
      state: "partly_met",
      reason: null,
    });
  });

  it("counts on Home only goals that are met: a bare mandate never, a held one also below the floor", async () => {
    const atRecording = await homeCover(quotesOn("sandbox"));
    expect(atRecording.held).toMatchObject({ goals: 1, met: 1 });
    expect(atRecording.bare).toMatchObject({ goals: 1, met: 0 });
    const fallen = await homeCover(quotesOn("sandbox", { spotUsd: 57_000 }));
    expect(fallen.held).toMatchObject({ goals: 1, met: 1 });
    expect(fallen.bare).toMatchObject({ goals: 1, met: 0 });
  });
});

/** Home's cover counts for two mandates with the hosted weekly goal: one holds its positions, one nothing. */
async function homeCover(ladder: LadderSource) {
  const held = {
    id: "mnd_held",
    name: "Held",
    deployment: null,
    contract: null,
    createdAt: "2026-11-18T03:00:00Z",
  };
  const bare = { ...held, id: "mnd_bare", name: "Bare" };
  const snapshots: Record<string, ConsoleSnapshot> = {
    [held.id]: snapshot({ intents: intentViews(), plans: [weeklyGoal] }),
    [bare.id]: snapshot({ intents: [], plans: [weeklyGoal] }),
  };
  const service = {
    accounts: {
      store: {
        mandates: () => [held, bare],
        agentOf: (id: string) => ({
          id: `agt_${id}`,
          address: "0x0000000000000000000000000000000000000001",
        }),
      },
    },
    serverContract: null,
    snapshot: (mandate: { id: string }) => snapshots[mandate.id],
    config: { mandates: { maxPerWorkspace: 5 } },
  } as unknown as ConsoleService;
  const access = {
    workspace: { id: "ws", name: "First workspace" },
    member: { role: "admin" },
  } as unknown as Access;
  const home = await workspaceHome(access, service, ladder);
  const coverOf = (id: string) => home.mandates.find((row) => row.mandate.id === id)?.cover;
  return { held: coverOf(held.id), bare: coverOf(bare.id) };
}
