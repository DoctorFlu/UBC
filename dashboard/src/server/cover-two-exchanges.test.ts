import { GEMINI_HOSTS } from "@mandate/gemini";
import {
  HOSTED_HOLDING,
  HOSTED_INTENTS,
  HOSTED_WEEKLY_PLAN,
  TWO_EXCHANGES_AT,
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

function quotesOn(venue: "production" | "sandbox"): LadderSource {
  const { fetch } = twoExchangeFetch(() => NOW);
  const quotes = new MarketQuotes({
    baseUrl: GEMINI_HOSTS[venue],
    productionBaseUrl: GEMINI_HOSTS.production,
    fetch,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return (asset, eventTicker) => quotes.ladder(asset, eventTicker);
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

  it("says so on the Hedge page, with the goal's real floor", async () => {
    const lookup = await quotesOn("sandbox")("BTC", WEEKLY);
    if (!lookup.ok) throw new Error("the sandbox ladder did not answer");
    const cover = coverNow({
      plan: weeklyGoal.plan,
      holdingQuantity: HOSTED_HOLDING.quantity,
      quotes: ladderQuotes(lookup.ladder, lookup.elsewhere),
      intents: intentViews(),
    });
    if (!cover) throw new Error("no cover");
    const sentence = coverSentence(cover.assessment, "Nov 20, 22:00 UTC");
    expect(sentence).toMatch(/^Covered\. If BTC settles below \$61,000 on Nov 20, 22:00 UTC/);
    expect(sentence).not.toContain("$0 ");
    expect(cover.assessment.state).toBe("met");
  });

  it("does not count a goal as covered on Home when nothing is held and the venue lists no strike below spot", async () => {
    // Two mandates with the same weekly goal: one holds the hosted positions, the other holds nothing.
    const held = {
      id: "mnd_held",
      name: "Held",
      deployment: null,
      contract: null,
      createdAt: "2026-11-18T03:00:00Z",
    };
    const bare = {
      id: "mnd_bare",
      name: "Bare",
      deployment: null,
      contract: null,
      createdAt: "2026-11-18T03:00:00Z",
    };
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
    const home = await workspaceHome(access, service, quotesOn("sandbox"));
    const coverOf = (id: string) => home.mandates.find((row) => row.mandate.id === id)?.cover;
    expect(coverOf(held.id)).toMatchObject({ goals: 1, met: 1 });
    expect(coverOf(bare.id)).toMatchObject({ goals: 1, met: 0 });
  });
});
