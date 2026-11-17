import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import {
  FILL_GRACE_SECONDS,
  MAX_EVENT_AGE_MS,
  MemoryWakeStore,
  RUN_QUIET_MS,
  SETTLED_NEWS_MS,
  WAKE_DEBOUNCE_MS,
  WAKE_RETRY_DELAYS_MS,
  WakeNotifier,
  WakeTarget,
  chainWakes,
  initialPriceMemory,
  ladderSettledWake,
  mergeWakeDetail,
  priceWakes,
  wakeEventSchema,
  wakeId,
  wakeSummary,
  type ChainWakeContext,
  type PolicyEvent,
  type PolicyRules,
  type PriceGoal,
  type Settlement,
  type WakeCandidate,
  type WakeEvent,
} from "../src";

const MARKET = "GEMI-BTC2611202200-HI65000";
const T0 = Date.parse("2026-11-16T12:00:00Z");
const RULES: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: 1,
  approvalAboveCents: 2_000,
  dailyLossCents: 0,
  paused: false,
};

/** Events in consecutive transactions, one per call unless `sameTx` is set; times in seconds from T0. */
function history() {
  let block = 0;
  const out: PolicyEvent[] = [];
  let tx: Hex = "0x00";
  let logIndex = 0;
  function add<E extends PolicyEvent["type"]>(
    type: E,
    fields: Omit<Extract<PolicyEvent, { type: E }>, keyof Meta | "type">,
    options: { at?: number; sameTx?: boolean } = {},
  ): PolicyEvent {
    if (!options.sameTx) {
      block += 1;
      tx = keccak256(toHex(`tx-${String(block)}`));
      logIndex = 0;
    } else logIndex += 1;
    const event = {
      type,
      blockNumber: block,
      blockTimestamp: Math.floor(T0 / 1000) + (options.at ?? block),
      transactionHash: tx,
      logIndex,
      ...fields,
    } as unknown as PolicyEvent;
    out.push(event);
    return event;
  }
  return { add, events: out };
}
type Meta = { blockNumber: number; blockTimestamp: number; transactionHash: Hex; logIndex: number };

const ctx = (over: Partial<ChainWakeContext> = {}): ChainWakeContext => ({
  deploymentId: "dep",
  now: T0 + 60_000,
  runInProgress: false,
  history: false,
  ...over,
});

const approved = (intentId: number, amountCents = 1_000) =>
  ({ intentId, market: MARKET, outcome: "NO", isBuy: true, amountCents, limitPrice: 31 }) as const;

describe("chainWakes", () => {
  it("wakes for owner changes, once per setPolicy, and never for a pause that changes nothing", () => {
    const h = history();
    const set = h.add("PolicyUpdated", { rules: RULES });
    h.add("Paused", { paused: false }, { sameTx: true });
    const pause = h.add("Paused", { paused: true });
    const again = h.add("Paused", { paused: true });
    const resume = h.add("Paused", { paused: false });
    const result = chainWakes(h.events, h.events, ctx());
    expect(result.wakes.map((w) => [w.kind, w.detail])).toEqual([
      ["mandate_changed", { change: "rules", paused: false }],
      ["mandate_changed", { change: "paused", paused: true }],
      ["mandate_changed", { change: "resumed", paused: false }],
    ]);
    expect(result.wakes.map((w) => w.sourceId)).toEqual(
      [set, pause, resume].map((e) => `chain:dep:${e.transactionHash}:${String(e.logIndex)}`),
    );
    expect(result.dropped.map((d) => d.reason)).toEqual(["same_transaction", "no_change"]);
    expect(result.dropped[1]?.event).toBe(again);
  });

  it("tells the owner's decisions from verdicts given at proposal", () => {
    const h = history();
    h.add("IntentProposed", {
      ...approved(0),
      agent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      category: 0,
      contextHash: `0x${"0".repeat(64)}`,
    });
    h.add("IntentApproved", approved(0), { sameTx: true });
    h.add("IntentNeedsApproval", { intentId: 1, amountCents: 2_200 });
    h.add("IntentNeedsApproval", { intentId: 2, amountCents: 2_400 });
    h.add("IntentApproved", approved(1, 2_200));
    h.add("IntentRejected", { intentId: 2, reason: "rejected by user" });
    h.add("IntentRejected", { intentId: 3, reason: "over max trade size" });
    const result = chainWakes(h.events, h.events, ctx());
    expect(result.wakes.map((w) => [w.kind, w.detail])).toEqual([
      ["owner_decision", { intents: [{ id: 1, market: MARKET, decision: "approved", reason: null }] }],
      [
        "owner_decision",
        { intents: [{ id: 2, market: null, decision: "rejected", reason: "rejected by user" }] },
      ],
      ["intent_rejected", { intents: [{ id: 3, market: null, reason: "over max trade size" }] }],
    ]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "not_a_trigger",
      "proposal_verdict",
      "not_a_trigger",
      "not_a_trigger",
    ]);
  });

  it("drops what the run in progress caused, but never the owner's decisions", () => {
    const h = history();
    h.add("IntentNeedsApproval", { intentId: 0, amountCents: 2_200 });
    h.add("IntentRejected", { intentId: 0, reason: "rejected by user" });
    h.add("IntentRejected", { intentId: 1, reason: "agent paused" });
    h.add("IntentApproved", approved(2), { at: 10 });
    h.add("ResultRecorded", { intentId: 2, filled: true, filledCents: 1_000, pnlCents: 0 }, { at: 10 + 600 });
    h.add("ResultRecorded", { intentId: 3, filled: false, filledCents: 0, pnlCents: 0 });
    const result = chainWakes(h.events, h.events, ctx({ runInProgress: true, now: T0 + 700_000 }));
    expect(result.wakes.map((w) => w.kind)).toEqual(["owner_decision"]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "not_a_trigger",
      "own_run",
      "proposal_verdict",
      "own_run",
      "own_run",
    ]);
  });

  it("wakes for a late fill and a failed order, not for the fill that follows its approval", () => {
    const h = history();
    h.add("IntentApproved", approved(0), { at: 10 });
    h.add(
      "ResultRecorded",
      { intentId: 0, filled: true, filledCents: 1_000, pnlCents: 0 },
      { at: 10 + FILL_GRACE_SECONDS },
    );
    h.add("IntentApproved", approved(1), { at: 20 });
    h.add(
      "ResultRecorded",
      { intentId: 1, filled: true, filledCents: 900, pnlCents: -5 },
      { at: 21 + FILL_GRACE_SECONDS },
    );
    h.add("IntentApproved", approved(2), { at: 30 });
    h.add("ResultRecorded", { intentId: 2, filled: false, filledCents: 0, pnlCents: 0 }, { at: 31 });
    const result = chainWakes(h.events, h.events, ctx({ now: T0 + 200_000 }));
    expect(result.wakes.map((w) => [w.kind, w.detail])).toEqual([
      ["order_filled", { intents: [{ id: 1, market: MARKET, filledCents: 900, pnlCents: -5 }] }],
      ["order_failed", { intents: [{ id: 2, market: MARKET }] }],
    ]);
    expect(result.dropped.filter((d) => d.reason === "expected_fill")).toHaveLength(1);
  });

  it("never wakes for history or for events older than the age limit", () => {
    const h = history();
    h.add("Paused", { paused: true }, { at: 0 });
    expect(chainWakes(h.events, h.events, ctx({ history: true })).dropped[0]?.reason).toBe("history");
    const late = ctx({ now: T0 + MAX_EVENT_AGE_MS + 1 });
    expect(chainWakes(h.events, h.events, late).dropped[0]?.reason).toBe("stale");
    // A block time ahead of the console's clock is not stale.
    expect(chainWakes(h.events, h.events, ctx({ now: T0 - 60_000 })).wakes).toHaveLength(1);
  });
});

describe("priceWakes", () => {
  const goal: PriceGoal = {
    planId: "plan_1",
    asset: "BTC",
    eventTicker: "BTC2611202200",
    floorCents: 6_300_000,
    planSpotCents: 6_471_000,
  };

  it("wakes once when spot falls below the floor, and again only after it recovered", () => {
    let memory = initialPriceMemory(goal);
    const read = (spotCents: number) => {
      const out = priceWakes(goal, memory, { spotCents, cover: null }, T0);
      memory = out.memory;
      return out.wakes.map((w) => [w.kind, w.sourceId]);
    };
    expect(read(6_400_000)).toEqual([]);
    expect(read(6_290_000)).toEqual([["price_below_floor", "price:plan_1:below:1"]]);
    expect(read(6_250_000)).toEqual([]);
    // Back above the floor, but inside the re-arm band: a dip again is the same fall.
    expect(read(6_310_000)).toEqual([]);
    expect(read(6_299_000)).toEqual([]);
    expect(read(6_400_000)).toEqual([]);
    expect(read(6_200_000)).toEqual([["price_below_floor", "price:plan_1:below:2"]]);
  });

  it("wakes when a rise of spot loses cover that was met, not on the first check", () => {
    let memory = initialPriceMemory(goal);
    const read = (spotCents: number, state: "met" | "partly_met" | "not_met") => {
      const out = priceWakes(goal, memory, { spotCents, cover: { state, coverBps: 9_000 } }, T0);
      memory = out.memory;
      return out.wakes.map((w) => w.kind);
    };
    expect(read(6_480_000, "partly_met")).toEqual([]);
    expect(read(6_480_000, "met")).toEqual([]);
    // Cover lost without a rise (an owner rejection): the chain trigger covers it.
    expect(read(6_470_000, "partly_met")).toEqual([]);
    expect(read(6_470_000, "met")).toEqual([]);
    expect(read(6_600_000, "partly_met")).toEqual(["cover_lost"]);
    expect(read(6_700_000, "partly_met")).toEqual([]);
  });
});

// ------------------------------------------------------------------ the notifier

/** A clock and timers the test moves by hand. */
function simulatedTime(start = T0) {
  let now = start;
  let timers: { at: number; task: () => void }[] = [];
  return {
    now: () => now,
    schedule: (task: () => void, ms: number) => {
      const timer = { at: now + ms, task };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((t) => t !== next);
        now = Math.max(now, next.at);
        next.task();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

const URL_WITH_SECRET = "https://hooks.example.test/routines/secret-path-123/run";
const KEY = "routine-key-abcdef";

function receiver(answer: (n: number) => number | Error = () => 200) {
  const bodies: WakeEvent[] = [];
  const headers: string[] = [];
  let n = 0;
  const fetch = (_url: string, init: RequestInit) => {
    n += 1;
    const result = answer(n);
    if (result instanceof Error) return Promise.reject(result);
    bodies.push(wakeEventSchema.parse(JSON.parse(init.body as string)));
    headers.push(String((init.headers as Record<string, string>).authorization));
    return Promise.resolve(new Response(null, { status: result }));
  };
  return { fetch, bodies, headers, calls: () => n };
}

function rejected(id: number, at = T0): WakeCandidate {
  return {
    kind: "intent_rejected",
    detail: { intents: [{ id, market: MARKET, reason: "over max trade size" }] },
    sourceId: `chain:dep:0x${id.toString(16).padStart(64, "0")}:0`,
    occurredAt: at,
  };
}

function setup(
  options: { cap?: number; answer?: (n: number) => number | Error; store?: MemoryWakeStore } = {},
) {
  const time = simulatedTime();
  const rx = receiver(options.answer);
  const logs: string[] = [];
  const store = options.store ?? new MemoryWakeStore();
  const notifier = new WakeNotifier({
    target: new WakeTarget(URL_WITH_SECRET, KEY),
    dailyCap: options.cap ?? 12,
    store,
    publicUrl: "https://console.example.test/",
    fetch: rx.fetch,
    now: time.now,
    schedule: time.schedule,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  notifier.start();
  return { time, rx, logs, store, notifier };
}

describe("ladderSettledWake", () => {
  const doc = (intentId: number, patch: Partial<Settlement> = {}): Settlement => ({
    version: 1,
    chainId: 5042002,
    policy: `0x${"ab".repeat(20)}`,
    intentId,
    market: MARKET,
    eventTicker: "BTC2611202200",
    strikeCents: 6_500_000,
    expiresAt: "2026-11-20T22:00:00.000Z",
    outcome: "NO",
    costCents: 1_240,
    limitPrice: 31,
    contractsHundredths: 4_000,
    resolution: "yes",
    payoutCents: 0,
    pnlCents: -1_240,
    settlementValue: "65210",
    resolvedAt: "2026-11-20T22:00:08.232Z",
    venue: "simulated",
    ...patch,
  });
  const input = (filledBuys: number[], settlements: Settlement[]) => ({
    deploymentId: "5042002:0xabc",
    eventTicker: "BTC2611202200",
    filledBuys,
    settlements,
    now: T0,
  });

  it("waits until every filled buy on the ladder is settled, then offers one trigger for the ladder", () => {
    const other = doc(9, { eventTicker: "ETH2611202200", market: "GEMI-ETH2611202200-HI2800" });
    expect(ladderSettledWake(input([1, 2], [doc(1), other]))).toBeNull();
    expect(ladderSettledWake(input([], [other]))).toBeNull();
    const wake = ladderSettledWake(input([1, 2], [doc(1), doc(2), other]));
    expect(wake).toEqual({
      kind: "ladder_settled",
      sourceId: "settlement:5042002:0xabc:BTC2611202200",
      occurredAt: T0,
      detail: {
        ladders: [
          {
            asset: "BTC",
            eventTicker: "BTC2611202200",
            expiresAt: "2026-11-20T22:00:00.000Z",
            settlementValue: "65210",
            positions: 2,
            costCents: 2_480,
            payoutCents: 0,
            pnlCents: -2_480,
          },
        ],
      },
    });
    if (!wake) throw new Error("no wake-up");
    expect(wakeSummary(wake, 1)).toBe(
      "The BTC ladder BTC2611202200 settled at $65,210.00: 2 positions cost $24.80, paid $0, net -$24.80. " +
        "Plan on the next ladder.",
    );
  });

  it("carries Gemini's estimated fees next to cost and payout, and the net after them", () => {
    const gemini = (id: number) => doc(id, { venue: "gemini", feeCents: 60, pnlCents: -1_300 });
    const wake = ladderSettledWake(input([1, 2], [gemini(1), gemini(2)]));
    expect(wake?.kind === "ladder_settled" && wake.detail.ladders[0]).toMatchObject({
      costCents: 2_480,
      feeCents: 120,
      payoutCents: 0,
      pnlCents: -2_600,
    });
    if (!wake) throw new Error("no wake-up");
    expect(wakeSummary(wake, 1)).toBe(
      "The BTC ladder BTC2611202200 settled at $65,210.00: 2 positions cost $24.80, fees $1.20 (estimated), " +
        "paid $0, net after fees -$26. Plan on the next ladder.",
    );
  });

  it("treats a ladder that expired more than a day before as history, not news", () => {
    const expiry = Date.parse("2026-11-20T22:00:00.000Z");
    const at = (now: number) => ladderSettledWake({ ...input([1], [doc(1)]), now });
    expect(at(expiry + SETTLED_NEWS_MS)).not.toBeNull();
    expect(at(expiry + SETTLED_NEWS_MS + 1)).toBeNull();
  });

  it("merges two ladders that settle inside one window, each listed once", () => {
    const btc = ladderSettledWake(input([1], [doc(1)]));
    const eth = ladderSettledWake({
      ...input([5], [doc(5, { eventTicker: "ETH2611202200", market: "GEMI-ETH2611202200-HI2800" })]),
      eventTicker: "ETH2611202200",
    });
    if (!btc || !eth) throw new Error("no wake-up");
    const merged = mergeWakeDetail(mergeWakeDetail(btc, eth), btc);
    expect(merged.kind === "ladder_settled" && merged.detail.ladders.map((l) => l.eventTicker)).toEqual([
      "ETH2611202200",
      "BTC2611202200",
    ]);
    expect(wakeSummary(merged, 2)).toBe(
      "2 ladders settled (ETH2611202200, BTC2611202200): cost $24.80, paid $0, net -$24.80 in all. " +
        "Plan on the next ladders.",
    );
  });
});

describe("WakeNotifier", () => {
  it("posts a well-formed event with the bearer key, once per trigger", async () => {
    const { time, rx, notifier } = setup();
    notifier.offer([rejected(3)]);
    notifier.offer([rejected(3)]);
    await time.advance(0);
    expect(rx.bodies).toHaveLength(1);
    expect(rx.headers).toEqual([`Bearer ${KEY}`]);
    expect(rx.bodies[0]).toMatchObject({
      type: "mandate.wake",
      version: 1,
      id: wakeId(rejected(3).sourceId),
      kind: "intent_rejected",
      count: 1,
      attempt: 1,
      summary: "The contract rejected intent #3: over max trade size.",
      link: "https://console.example.test/activity/3",
    });
    expect(JSON.stringify(rx.bodies[0]).length).toBeLessThan(1_000);
    expect(notifier.status()).toMatchObject({ usedToday: 1, leftToday: 11 });
  });

  it("holds a second trigger of the same kind until the window ends, carrying every trigger in one", async () => {
    const { time, rx, notifier } = setup();
    notifier.offer([rejected(1)]);
    await time.advance(0);
    for (let id = 2; id <= 30; id++) notifier.offer([rejected(id)]);
    await time.advance(WAKE_DEBOUNCE_MS.intent_rejected - 1);
    expect(rx.bodies).toHaveLength(1);
    expect(notifier.status().recent[0]).toMatchObject({ status: "queued", count: 29 });
    await time.advance(1);
    expect(rx.bodies).toHaveLength(2);
    expect(rx.bodies[1]).toMatchObject({ count: 29 });
    const second = rx.bodies[1];
    expect(second?.kind === "intent_rejected" ? second.detail.intents.map((i) => i.id) : []).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    // Other kinds are not held back by it.
    notifier.offer([
      {
        kind: "mandate_changed",
        detail: { change: "paused", paused: true },
        sourceId: "pause",
        occurredAt: time.now(),
      },
    ]);
    await time.advance(0);
    expect(rx.bodies.map((b) => b.kind)).toEqual(["intent_rejected", "intent_rejected", "mandate_changed"]);
  });

  it("stops at the daily cap and counts again the next UTC day", async () => {
    const { time, rx, notifier } = setup({ cap: 2 });
    notifier.offer([
      {
        kind: "mandate_changed",
        detail: { change: "paused", paused: true },
        sourceId: "m",
        occurredAt: time.now(),
      },
    ]);
    await time.advance(0);
    notifier.offer([rejected(1)]);
    await time.advance(0);
    notifier.offer([
      { ...rejected(2), kind: "order_failed", detail: { intents: [{ id: 2, market: null }] } },
    ]);
    await time.advance(0);
    expect(rx.bodies.map((b) => b.kind)).toEqual(["mandate_changed", "intent_rejected"]);
    const status = notifier.status();
    expect(status).toMatchObject({ usedToday: 2, leftToday: 0 });
    expect(status.recent.filter((d) => d.status === "capped")).toHaveLength(1);
    await time.advance(24 * 3_600_000);
    notifier.offer([rejected(3)]);
    await time.advance(WAKE_DEBOUNCE_MS.intent_rejected);
    expect(rx.bodies).toHaveLength(3);
  });

  it("retries network errors and 5xx with backoff, never a 4xx", async () => {
    const flaky = setup({ answer: (n) => (n === 1 ? new TypeError("fetch failed") : n === 2 ? 503 : 200) });
    flaky.notifier.offer([rejected(1)]);
    await flaky.time.advance(0);
    expect(flaky.notifier.status().recent[0]).toMatchObject({
      status: "queued",
      result: "network error, retrying",
    });
    await flaky.time.advance(WAKE_RETRY_DELAYS_MS[0] ?? 0);
    expect(flaky.notifier.status().recent[0]).toMatchObject({ result: "HTTP 503, retrying" });
    await flaky.time.advance(WAKE_RETRY_DELAYS_MS[1] ?? 0);
    expect(flaky.rx.calls()).toBe(3);
    expect(flaky.rx.bodies.map((b) => [b.id, b.attempt])).toEqual([
      [wakeId(rejected(1).sourceId), 2],
      [wakeId(rejected(1).sourceId), 3],
    ]);
    expect(flaky.notifier.status()).toMatchObject({ usedToday: 1 });

    const refused = setup({ answer: () => 401 });
    refused.notifier.offer([rejected(1)]);
    await refused.time.advance(60 * 60_000);
    expect(refused.rx.calls()).toBe(1);
    expect(refused.notifier.status()).toMatchObject({ usedToday: 0 });
    expect(refused.notifier.status().recent[0]).toMatchObject({
      status: "failed",
      result: "HTTP 401, not retried",
    });

    const down = setup({ answer: () => 502 });
    down.notifier.offer([rejected(1)]);
    await down.time.advance(60 * 60_000);
    expect(down.rx.calls()).toBe(WAKE_RETRY_DELAYS_MS.length + 1);
    expect(down.notifier.status().recent[0]).toMatchObject({
      status: "failed",
      result: "HTTP 502, gave up after 5 tries",
    });
  });

  it("never resends after a restart: not what was sent, and not what was in flight", async () => {
    const store = new MemoryWakeStore();
    const first = setup({ store });
    first.notifier.offer([rejected(1)]);
    await first.time.advance(0);
    // A request in flight when the process stopped.
    first.notifier.offer([
      { ...rejected(2), kind: "order_failed", detail: { intents: [{ id: 2, market: null }] } },
    ]);
    const pending = store.queued()[0];
    if (!pending) throw new Error("nothing queued");
    store.update({ ...pending, status: "sending", attempts: 1, attemptedAt: first.time.now() });
    first.notifier.stop();

    const second = setup({ store });
    second.notifier.offer([rejected(1)]);
    await second.time.advance(60 * 60_000);
    expect(second.rx.calls()).toBe(0);
    expect(
      second.notifier
        .status()
        .recent.map((d) => d.status)
        .sort(),
    ).toEqual(["failed", "sent"]);
    expect(second.notifier.status().usedToday).toBe(2);
  });

  it("keeps the queue bounded", async () => {
    const { time, notifier, store } = setup({ answer: () => 503 });
    // Every kind fails and waits for a retry, then new triggers keep coming: one waits per kind.
    for (let round = 0; round < 10; round++) {
      for (let id = 0; id < 50; id++) notifier.offer([rejected(round * 100 + id)]);
      await time.advance(1_000);
    }
    expect(store.queued().length).toBeLessThanOrEqual(2);
  });

  it("is off without a target, and never shows or logs the URL or key", async () => {
    const off = new WakeNotifier({ target: null, dailyCap: 12, store: new MemoryWakeStore() });
    off.start();
    off.offer([rejected(1)]);
    expect(off.status()).toEqual({ enabled: false, dailyCap: 12, usedToday: 0, leftToday: 12, recent: [] });

    const { time, notifier, logs, store } = setup({
      answer: (n) => (n === 1 ? new Error(`connect ${URL_WITH_SECRET}`) : 500),
    });
    notifier.offer([rejected(1)]);
    await time.advance(60 * 60_000);
    const target = new WakeTarget(URL_WITH_SECRET, KEY);
    const seen = [
      ...logs,
      JSON.stringify(notifier.status()),
      JSON.stringify([...store.deliveries.values()]),
      JSON.stringify({ target }),
      String(target),
      [target].join(""),
      inspect(target),
      inspect({ target }),
    ].join("\n");
    expect(seen).not.toContain("secret-path");
    expect(seen).not.toContain("hooks.example.test");
    expect(seen).not.toContain(KEY);
    expect(() => new WakeTarget("not a url with secret-path", KEY)).toThrow(/^the webhook URL must be/);
    expect(() => new WakeTarget("ftp://x/secret-path", KEY)).toThrow(/^the webhook URL must be/);
  });

  it("knows a run is in progress for a while after the agent's last call", () => {
    const { time, notifier } = setup();
    expect(notifier.runInProgress()).toBe(false);
    notifier.noteAgentActivity();
    expect(notifier.runInProgress(time.now() + RUN_QUIET_MS - 1)).toBe(true);
    expect(notifier.runInProgress(time.now() + RUN_QUIET_MS)).toBe(false);
  });
});
