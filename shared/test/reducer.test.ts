import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import {
  applyEvent,
  applyEvents,
  emptyPolicyViewState,
  intentsMissingDetails,
  listIntents,
  lossTodayCents,
  mergeIntentDetails,
  pendingApprovals,
  policyStateAt,
  reduceEvents,
  SECONDS_PER_DAY,
  ZERO_HASH,
  type EventMeta,
  type Intent,
  type PolicyEvent,
  type PolicyRules,
} from "../src";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MARKET = "GEMI-BTC2611202200-HI65000";
const DAY = 20_000; // a UTC day number
const NOON = DAY * SECONDS_PER_DAY + 12 * 3600;

const rules: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: 1,
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

/** Builds events with consecutive positions: one block per call, one log per event in that block. */
function chain() {
  let block = 0;
  let time = NOON;
  const out: PolicyEvent[] = [];
  const tx = (events: ((meta: EventMeta) => PolicyEvent)[], advanceSeconds = 12) => {
    block += 1;
    time += advanceSeconds;
    const hash: Hex = keccak256(toHex(`tx-${block}`));
    events.forEach((make, logIndex) => {
      out.push(make({ blockNumber: block, blockTimestamp: time, transactionHash: hash, logIndex }));
    });
  };
  return { tx, events: out };
}

const proposed =
  (intentId: number, amountCents: number, isBuy = true) =>
  (meta: EventMeta): PolicyEvent => ({
    ...meta,
    type: "IntentProposed",
    intentId,
    agent: AGENT,
    market: MARKET,
    category: 0,
    outcome: "YES",
    isBuy,
    amountCents,
    limitPrice: 65,
    contextHash: ZERO_HASH,
  });
const approved =
  (intentId: number, amountCents: number, isBuy = true) =>
  (meta: EventMeta): PolicyEvent => ({
    ...meta,
    type: "IntentApproved",
    intentId,
    market: MARKET,
    outcome: "YES",
    isBuy,
    amountCents,
    limitPrice: 65,
  });
const rejected =
  (intentId: number, reason: string) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "IntentRejected", intentId, reason });
const needsApproval =
  (intentId: number, amountCents: number) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "IntentNeedsApproval", intentId, amountCents });
const result =
  (intentId: number, filled: boolean, filledCents: number, pnlCents: number) =>
  (meta: EventMeta): PolicyEvent => ({
    ...meta,
    type: "ResultRecorded",
    intentId,
    filled,
    filledCents,
    pnlCents,
  });
const policyUpdated =
  (r: PolicyRules) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "PolicyUpdated", rules: r });
const pausedEvent =
  (paused: boolean) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "Paused", paused });

/**
 * A realistic history covering every event type and status. Ids start at 0, like the contract's array.
 * `setPolicy` emits `PolicyUpdated` then `Paused`, so the first transaction carries both.
 */
function scenario() {
  const c = chain();
  c.tx([policyUpdated(rules), pausedEvent(false)]);
  c.tx([proposed(0, 1_000), approved(0, 1_000)]); // auto approved buy
  c.tx([proposed(1, 2_200), needsApproval(1, 2_200)]); // held
  c.tx([proposed(2, 3_000), rejected(2, "over max trade size")]);
  c.tx([result(0, true, 900, -300)]); // partial fill, loss
  c.tx([approved(1, 2_200)]); // user approves
  c.tx([proposed(3, 2_100), needsApproval(3, 2_100)]);
  c.tx([rejected(3, "rejected by user")]);
  c.tx([result(1, false, 0, 0)]); // unfilled: budget released
  c.tx([proposed(4, 500, false), approved(4, 500, false)]); // sell: no budget
  c.tx([result(4, true, 500, 120)]);
  c.tx([proposed(5, 400), needsApproval(5, 400)]); // left waiting
  c.tx([proposed(6, 300, false), approved(6, 300, false)], SECONDS_PER_DAY); // next UTC day
  c.tx([result(6, true, 300, -50)]);
  c.tx([pausedEvent(true)]);
  c.tx([proposed(7, 100), rejected(7, "agent paused")]);
  return c.events;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const REJECTIONS = { "over max trade size": 1, "rejected by user": 1, "agent paused": 1 };

describe("reduceEvents", () => {
  it("rebuilds rules, intents, committed spend, losses and counts", () => {
    const state = reduceEvents(scenario());

    expect(state.rules).toEqual({ ...rules, paused: true });
    expect(state.paused).toBe(true);
    // 1000 approved then corrected to 900; 2200 approved then released to 0; sells never count.
    expect(state.committedCents).toBe(900);
    expect(state.realizedPnlCents).toBe(-300 + 0 + 120 - 50);
    expect(state.lossByDay).toEqual({ [DAY]: 300, [DAY + 1]: 50 });
    expect(state.rejectionsByReason).toEqual(REJECTIONS);
    expect(state.counts).toEqual({
      proposed: 8,
      approved: 4,
      rejected: 3,
      needsApproval: 3,
      executed: 3,
      failed: 1,
    });

    const statuses = Object.fromEntries(listIntents(state).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({
      0: "executed",
      1: "failed",
      2: "rejected",
      3: "rejected",
      4: "executed",
      5: "needs_approval",
      6: "executed",
      7: "rejected",
    });
    expect(state.intents[0]).toMatchObject({ filledCents: 900, pnlCents: -300, reason: null, agent: AGENT });
    expect(state.intents[3]?.reason).toBe("rejected by user");
    expect(state.intents[1]?.decidedTxHash).not.toBe(state.intents[1]?.proposedTxHash);
    expect(pendingApprovals(state).map((i) => i.id)).toEqual([5]);
    expect(intentsMissingDetails(state)).toEqual([]);
  });

  it("gives the same state for any delivery order", () => {
    const events = scenario();
    const expected = reduceEvents(events);
    for (let seed = 1; seed <= 50; seed++) {
      expect(reduceEvents(shuffled(events, seed))).toEqual(expected);
    }
  });

  it("ignores duplicates", () => {
    const events = scenario();
    expect(reduceEvents([...events, ...shuffled(events, 3), events[4] as PolicyEvent])).toEqual(
      reduceEvents(events),
    );
  });

  it("starts empty", () => {
    expect(reduceEvents([])).toEqual(emptyPolicyViewState());
  });
});

describe("production contract events only (no IntentProposed)", () => {
  const baseOnly = () => scenario().filter((e) => e.type !== "IntentProposed");

  it("keeps every total and status exact", () => {
    const full = reduceEvents(scenario());
    const state = reduceEvents(baseOnly());
    expect(state.committedCents).toBe(full.committedCents);
    expect(state.lossByDay).toEqual(full.lossByDay);
    expect(state.rejectionsByReason).toEqual(REJECTIONS);
    expect(state.counts).toEqual(full.counts);
    expect(listIntents(state).map((i) => i.status)).toEqual(listIntents(full).map((i) => i.status));
  });

  it("leaves details of intents rejected at proposal empty, and lists them for getIntent", () => {
    const state = reduceEvents(baseOnly());
    expect(state.intents[2]).toMatchObject({
      status: "rejected",
      market: null,
      amountCents: null,
      agent: null,
    });
    // Held intents carry the amount but not the market until approved.
    expect(state.intents[5]).toMatchObject({ status: "needs_approval", amountCents: 400, market: null });
    expect(state.intents[0]?.market).toBe(MARKET);
    // No base event carries the category, so every intent needs one getIntent read.
    expect(state.intents[0]?.category).toBeNull();
    expect(intentsMissingDetails(state)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("fills missing details from getIntent without overriding what events say", () => {
    const state = reduceEvents(baseOnly());
    const view = state.intents[2];
    if (!view) throw new Error("missing intent 2");
    const stored: Intent = {
      id: 2,
      market: MARKET,
      category: 0,
      outcome: "YES",
      isBuy: true,
      amountCents: 3_000,
      limitPrice: 65,
      // A stale read: the status must still come from the events.
      status: "none",
      proposedAt: view.proposedAt,
      filledCents: 0,
      pnlCents: 0,
    };
    const merged = mergeIntentDetails(view, stored);
    expect(merged).toMatchObject({ status: "rejected", reason: "over max trade size", amountCents: 3_000 });
    expect(merged.market).toBe(MARKET);
    expect(merged.agent).toBeNull();
    expect(() => mergeIntentDetails(view, { ...stored, id: 3 })).toThrow(RangeError);
  });
});

describe("applyEvent", () => {
  it("matches reduceEvents when applied one by one, in order or not, with duplicates", () => {
    const events = scenario();
    const expected = reduceEvents(events);
    expect(applyEvents(emptyPolicyViewState(), events)).toEqual(expected);
    for (let seed = 1; seed <= 20; seed++) {
      const delivery = shuffled([...events, ...events.slice(0, 5)], seed);
      expect(applyEvents(emptyPolicyViewState(), delivery)).toEqual(expected);
    }
  });

  it("never modifies the state it is given", () => {
    const events = scenario();
    const before = reduceEvents(events.slice(0, 6));
    const snapshot = structuredClone(before);
    applyEvent(before, events[6] as PolicyEvent);
    applyEvent(before, events[0] as PolicyEvent); // duplicate
    applyEvent(before, { ...(events[6] as PolicyEvent), blockNumber: 0, logIndex: 9 }); // out of order
    expect(before).toEqual(snapshot);
  });

  it("returns the same object for a duplicate", () => {
    const events = scenario();
    const state = reduceEvents(events);
    expect(applyEvent(state, events[3] as PolicyEvent)).toBe(state);
  });
});

describe("loss today", () => {
  it("reads the loss for the UTC day of the given time", () => {
    const state = reduceEvents(scenario());
    expect(lossTodayCents(state, NOON)).toBe(300);
    expect(lossTodayCents(state, NOON + SECONDS_PER_DAY)).toBe(50);
    expect(lossTodayCents(state, NOON + 2 * SECONDS_PER_DAY)).toBe(0);
    expect(policyStateAt(state, NOON)).toEqual({ committedCents: 900, lossTodayCents: 300 });
  });
});
