import { describe, expect, it } from "vitest";
import { createGeminiMarkets, eventTickerCandidates } from "../src/markets/gemini";
import { ProposalLedger, REPLAY_WINDOW_MS } from "../src/state/ledger";
import { MAX_PLANS, PLAN_RETAINED_FOR_MS, PlanStore, type StoredPlan } from "../src/state/plans";
import { Category } from "@mandate/shared";
import type { HedgePlan } from "@mandate/planner";

const t0 = new Date("2026-11-15T12:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

function entry(planId: string, createdAt = t0): Omit<StoredPlan, "outcomes" | "stoppedAt"> {
  return {
    plan: { planId, orders: [] } as unknown as HedgePlan,
    requestText: "r",
    createdAt,
    ladderSummary: { eventTicker: "E", observedAt: t0.toISOString(), rungs: [] },
    categoryId: Category.Crypto,
    consoleStored: false,
  };
}

describe("PlanStore", () => {
  it("keeps the first copy of a plan id and forgets plans after the retention time", () => {
    const store = new PlanStore();
    const first = store.put(entry("plan_a"), t0);
    first.outcomes.push({} as never);
    expect(store.put(entry("plan_a"), t0)).toBe(first);
    expect(store.get("plan_a", later(PLAN_RETAINED_FOR_MS - 1))).toBe(first);
    expect(store.get("plan_a", later(PLAN_RETAINED_FOR_MS + 1))).toBeUndefined();
  });

  it("keeps at most MAX_PLANS, dropping the oldest", () => {
    const store = new PlanStore();
    for (let i = 0; i <= MAX_PLANS; i++) store.put(entry(`plan_${i}`), t0);
    expect(store.get("plan_0", t0)).toBeUndefined();
    expect(store.get(`plan_${MAX_PLANS}`, t0)).toBeDefined();
  });

  it("runs work for one plan at a time, even when a run fails", async () => {
    const store = new PlanStore();
    const order: string[] = [];
    const slow = store.exclusive("p", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
      throw new Error("boom");
    });
    const fast = store.exclusive("p", () => {
      order.push("second");
      return Promise.resolve("ok");
    });
    await expect(slow).rejects.toThrow("boom");
    await expect(fast).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });
});

describe("ProposalLedger", () => {
  it("replays a kept result inside the window and runs again after it", async () => {
    const ledger = new ProposalLedger();
    let runs = 0;
    const work = () => Promise.resolve(++runs);
    expect(await ledger.once("k", t0, work, () => true)).toMatchObject({ value: 1, replayed: false });
    expect(await ledger.once("k", later(1_000), work, () => true)).toMatchObject({
      value: 1,
      replayed: true,
    });
    expect(await ledger.once("k", later(REPLAY_WINDOW_MS + 1), work, () => true)).toMatchObject({
      value: 2,
      replayed: false,
    });
  });

  it("does not keep results that are safe to retry, nor errors", async () => {
    const ledger = new ProposalLedger();
    await ledger.once(
      "k",
      t0,
      () => Promise.resolve("retryable"),
      () => false,
    );
    expect(
      await ledger.once(
        "k",
        t0,
        () => Promise.resolve("fresh"),
        () => true,
      ),
    ).toMatchObject({ value: "fresh" });
    await expect(
      ledger.once(
        "e",
        t0,
        () => Promise.reject(new Error("x")),
        () => true,
      ),
    ).rejects.toThrow("x");
    expect(
      await ledger.once(
        "e",
        t0,
        () => Promise.resolve("again"),
        () => true,
      ),
    ).toMatchObject({ replayed: false });
  });

  it("tracks queued decision contexts until the console stores them", () => {
    const ledger = new ProposalLedger();
    const hash = `0x${"a".repeat(64)}` as const;
    ledger.queueContext(hash, {} as never);
    ledger.remember(0, {
      contextHash: hash,
      contextStored: false,
      contextHashRecorded: false,
      planId: "direct",
      reason: "r",
    });
    ledger.contextStored(hash);
    expect(ledger.pendingContexts()).toEqual([]);
    expect(ledger.lookup(0)?.contextStored).toBe(true);
  });
});

describe("Gemini market resolution", () => {
  it("derives event ticker candidates from a symbol, longest first", () => {
    expect(eventTickerCandidates("GEMI-BTC2611202200-HI65000")).toEqual(["BTC2611202200"]);
    expect(eventTickerCandidates("GEMI-NFL-2611152125-SF-DAL-M-SF")).toEqual([
      "NFL-2611152125-SF-DAL-M",
      "NFL-2611152125-SF-DAL",
      "NFL-2611152125-SF",
      "NFL-2611152125",
    ]);
    expect(eventTickerCandidates("BTC-HI1")).toEqual([]);
    expect(eventTickerCandidates("GEMI-../x")).toEqual([]);
  });

  it("finds the event that lists the symbol and takes the category from Gemini", async () => {
    const calls: string[] = [];
    const event = {
      id: "9",
      ticker: "NFL-2611152125-SF-DAL-M",
      title: "SF vs DAL",
      category: "Sports",
      status: "active",
      contracts: [
        { id: "1", instrumentSymbol: "GEMI-NFL-2611152125-SF-DAL-M-SF", label: "SF", ticker: "SF" },
      ],
    };
    const markets = createGeminiMarkets({
      maxRetries: 0,
      fetch: (input) => {
        const path = new URL(input).pathname;
        calls.push(path);
        return Promise.resolve(
          path.endsWith("/NFL-2611152125-SF-DAL-M")
            ? Response.json(event)
            : Response.json({ error: "not found" }, { status: 404 }),
        );
      },
    });
    const resolved = await markets.resolveMarket("GEMI-NFL-2611152125-SF-DAL-M-SF");
    expect(resolved).toMatchObject({
      categoryId: Category.Sports,
      event: { ticker: "NFL-2611152125-SF-DAL-M" },
    });
    expect(await markets.resolveMarket("GEMI-NFL-2611152125-SF-DAL-M-XX")).toBeNull();
    expect(calls.every((path) => path.startsWith("/v1/prediction-markets/events/"))).toBe(true);
  });
});
