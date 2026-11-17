import { describe, expect, it } from "vitest";

import { emptyFixtureSnapshot, fixtureSnapshot } from "@/fixtures";

import { decidedAfterHold, needsOwner } from "./attention";
import type { ConsoleSnapshot } from "./types";

describe("needsOwner", () => {
  it("counts held intents, pending change requests and a pending pairing", () => {
    const attention = needsOwner(fixtureSnapshot);
    expect(attention.intents.map((intent) => intent.id)).toEqual([6]);
    expect(attention.changeRequests.every((request) => request.status === "pending")).toBe(true);
    expect(attention.changeRequests).toHaveLength(1);
    // The fixture's agent is already confirmed, so it waits for nothing.
    expect(attention.pairing).toBeNull();
    expect(attention.total).toBe(2);
  });

  it("includes a pairing only while it is pending", () => {
    const pairing = fixtureSnapshot.offchain.pairing;
    if (!pairing) throw new Error("the fixture has a pairing");
    const pending: ConsoleSnapshot = {
      ...fixtureSnapshot,
      offchain: { ...fixtureSnapshot.offchain, pairing: { ...pairing, status: "pending" } },
    };
    const attention = needsOwner(pending);
    expect(attention.pairing?.agentAddress).toBe(pairing.agentAddress);
    expect(attention.total).toBe(3);
  });

  it("is empty when nothing waits, and when the chain is unreachable", () => {
    expect(needsOwner(emptyFixtureSnapshot).total).toBe(0);
    const offline: ConsoleSnapshot = {
      ...emptyFixtureSnapshot,
      chain: null,
    };
    expect(needsOwner(offline).intents).toEqual([]);
  });
});

describe("decidedAfterHold", () => {
  it("lists intents that waited for the owner and were decided, with the deciding block time", () => {
    const chain = fixtureSnapshot.chain;
    if (!chain) throw new Error("the fixture has a chain");
    const decided = decidedAfterHold(chain);
    expect(decided.map(({ intent }) => intent.id)).toEqual([3]);
    expect(decided[0]?.intent.status).toBe("rejected");
    const rejection = chain.events.find((event) => event.type === "IntentRejected" && event.intentId === 3);
    expect(decided[0]?.decidedAt).toBe(rejection?.blockTimestamp);
  });

  it("leaves out an intent still waiting and intents that never waited", () => {
    const chain = fixtureSnapshot.chain;
    if (!chain) throw new Error("the fixture has a chain");
    const ids = decidedAfterHold(chain).map(({ intent }) => intent.id);
    expect(ids).not.toContain(6);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(0);
  });
});
