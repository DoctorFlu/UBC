import { describe, expect, it } from "vitest";

import { AccountStore } from "../accounts/store";
import { openDatabase } from "../db";
import { OffchainStore } from "./offchain";

/**
 * A goal per (mandate, asset, event): which stored plans are goals. The newest plan of an asset, and every
 * plan with an order proposed to the contract, are candidates; the newest candidate per event is its goal.
 */

const WEEKLY = "BTC2611202200";
const DAILY = "BTC2611182200";
const MONTHLY = "BTC2611302200";
const ETH_WEEKLY = "ETH2611202200";

function setup() {
  const db = openDatabase(":memory:");
  const mandate = new AccountStore(db).envMandate();
  let at = Date.parse("2026-11-18T08:00:00Z");
  const store = new OffchainStore(db, () => new Date(at));
  let intents = 0;
  return {
    goals: () => store.goalPlans(mandate.id).map((plan) => plan.planId),
    /** Stores a plan a minute after the last one. */
    plan(planId: string, eventTicker: string, asset = "BTC") {
      at += 60_000;
      store.putPlan(mandate.id, {
        planId,
        asset,
        requestText: "Protect my holding.",
        createdAt: new Date(at).toISOString(),
        plan: { asset, eventTicker, expiry: "2026-11-30T22:00:00Z", floorCents: 6_000_000 },
      });
    },
    /** An order of the plan proposed to the contract: its decision context, linked to an intent. */
    propose(planId: string) {
      const id = intents++;
      const hash = `0x${id.toString(16).padStart(64, "c")}` as const;
      store.putContext(mandate.id, hash, { version: 1, planId, rungIndex: 0 });
      store.linkIntentContext(mandate.id, "env", id, hash, `0x${id.toString(16).padStart(64, "d")}`);
    },
  };
}

describe("goal plans", () => {
  it("keeps a weekly with a proposed order beside a daily planned after it: two goals", () => {
    const t = setup();
    t.plan("weekly", WEEKLY);
    t.propose("weekly");
    t.plan("daily", DAILY);
    expect(t.goals()).toEqual(["daily", "weekly"]);
  });

  it("drops a daily never proposed once a third ladder is planned", () => {
    const t = setup();
    t.plan("weekly", WEEKLY);
    t.propose("weekly");
    t.plan("daily", DAILY);
    t.plan("monthly", MONTHLY);
    expect(t.goals()).toEqual(["monthly", "weekly"]);
  });

  it("keeps a plan whose every order the contract rejected: it was proposed", () => {
    // The store sees the proposal, not the verdict: a rejected intent is linked like any other.
    const t = setup();
    t.plan("rejected", WEEKLY);
    t.propose("rejected");
    t.plan("daily", DAILY);
    expect(t.goals()).toEqual(["daily", "rejected"]);
  });

  it("has one goal per event: a newer plan on the same ladder replaces the older one", () => {
    const t = setup();
    t.plan("weekly-1", WEEKLY);
    t.propose("weekly-1");
    t.plan("weekly-2", WEEKLY);
    expect(t.goals()).toEqual(["weekly-2"]);
    t.propose("weekly-2");
    t.plan("daily", DAILY);
    expect(t.goals()).toEqual(["daily", "weekly-2"]);
  });

  it("judges each asset on its own", () => {
    const t = setup();
    t.plan("btc-weekly", WEEKLY);
    t.plan("eth-weekly", ETH_WEEKLY, "ETH");
    t.plan("btc-daily", DAILY);
    // The BTC weekly was never proposed and the BTC daily is newer; the ETH plan is ETH's newest.
    expect(t.goals()).toEqual(["btc-daily", "eth-weekly"]);
  });
});
