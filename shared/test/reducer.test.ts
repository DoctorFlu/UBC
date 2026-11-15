import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import {
  applyEvent,
  applyEvents,
  emptyPolicyViewState,
  listIntents,
  lossTodayCents,
  pendingApprovals,
  policyStateAt,
  reduceEvents,
  SECONDS_PER_DAY,
  ZERO_HASH,
  type EventMeta,
  type Policy,
  type PolicyEvent,
} from "../src";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DAY = 20_000; // a UTC day number
const NOON = DAY * SECONDS_PER_DAY + 12 * 3600;

const policy: Policy = {
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
    market: "GEMI-BTC2611202200-HI65000",
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
    market: "GEMI-BTC2611202200-HI65000",
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
const policySet =
  (p: Policy) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "PolicySet", policy: p });
const pausedSet =
  (paused: boolean) =>
  (meta: EventMeta): PolicyEvent => ({ ...meta, type: "PausedSet", paused });

/** A realistic history covering every event type and status. */
function scenario() {
  const c = chain();
  c.tx([policySet(policy)]);
  c.tx([proposed(1, 1_000), approved(1, 1_000)]); // auto approved buy
  c.tx([proposed(2, 2_200), needsApproval(2, 2_200)]); // held
  c.tx([proposed(3, 3_000), rejected(3, "OVER_MAX_TRADE")]);
  c.tx([result(1, true, 900, -300)]); // partial fill, loss
  c.tx([approved(2, 2_200)]); // owner approves
  c.tx([proposed(4, 2_100), needsApproval(4, 2_100)]);
  c.tx([rejected(4, "REJECTED_BY_OWNER")]);
  c.tx([result(2, false, 0, 0)]); // unfilled: budget released
  c.tx([proposed(5, 500, false), approved(5, 500, false)]); // sell: no budget
  c.tx([result(5, true, 500, 120)]);
  c.tx([proposed(6, 400), needsApproval(6, 400)]); // left waiting
  c.tx([proposed(7, 300, false), approved(7, 300, false)], SECONDS_PER_DAY); // next UTC day
  c.tx([result(7, true, 300, -50)]);
  c.tx([pausedSet(true)]);
  c.tx([proposed(8, 100), rejected(8, "PAUSED")]);
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

describe("reduceEvents", () => {
  it("rebuilds policy, intents, spend, losses and counts", () => {
    const state = reduceEvents(scenario());

    expect(state.policy).toEqual({ ...policy, paused: true });
    expect(state.paused).toBe(true);
    // 1000 approved then corrected to 900; 2200 approved then released to 0; sell 5 does not count.
    expect(state.spentCents).toBe(900);
    expect(state.realizedPnlCents).toBe(-300 + 0 + 120 - 50);
    expect(state.lossByDay).toEqual({ [DAY]: 300, [DAY + 1]: 50 });
    expect(state.rejectionsByReason).toEqual({ OVER_MAX_TRADE: 1, REJECTED_BY_OWNER: 1, PAUSED: 1 });
    expect(state.counts).toEqual({
      proposed: 8,
      approved: 4,
      rejected: 3,
      needsApproval: 3,
      filled: 3,
      unfilled: 1,
    });

    const statuses = Object.fromEntries(listIntents(state).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({
      1: "filled",
      2: "unfilled",
      3: "rejected",
      4: "rejected",
      5: "filled",
      6: "needs_approval",
      7: "filled",
      8: "rejected",
    });
    expect(state.intents[1]).toMatchObject({ filledCents: 900, pnlCents: -300, reason: null });
    expect(state.intents[4]?.reason).toBe("REJECTED_BY_OWNER");
    expect(state.intents[2]?.decidedTxHash).not.toBe(state.intents[2]?.proposedTxHash);
    expect(pendingApprovals(state).map((i) => i.id)).toEqual([6]);
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

  it("keeps totals right without IntentProposed (spec-only contract)", () => {
    const events = scenario().filter((e) => e.type !== "IntentProposed");
    const state = reduceEvents(events);
    expect(state.spentCents).toBe(900);
    expect(state.rejectionsByReason).toEqual({ OVER_MAX_TRADE: 1, REJECTED_BY_OWNER: 1, PAUSED: 1 });
    expect(listIntents(state)).toEqual([]);
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
    expect(policyStateAt(state, NOON)).toEqual({ spentCents: 900, lossTodayCents: 300 });
  });
});
