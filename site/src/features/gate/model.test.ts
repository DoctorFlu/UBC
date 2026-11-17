import { DEMO_POLICY } from "@mandate/devchain";
import { Category, REASON_CODES, evaluateIntent } from "@mandate/shared/rules";
import { describe, expect, it } from "vitest";

import {
  AMOUNT_MAX_CENTS,
  AMOUNT_MIN_CENTS,
  DEFAULT_INPUT,
  SAMPLE_RULES,
  SAMPLE_STATE,
  clampAmount,
  evaluateGate,
  rowState,
  scheduleRows,
  verdictCopy,
  type GateInput,
} from "./model";

const at = (amountCents: number, extra: Partial<GateInput> = {}): GateInput => ({
  ...DEFAULT_INPUT,
  amountCents,
  ...extra,
});

function states(input: GateInput) {
  const evaluation = evaluateGate(input);
  return Object.fromEntries(scheduleRows(input).map((row) => [row.id, rowState(row, evaluation)]));
}

describe("the sample mandate", () => {
  it("is the demo chain's mandate, so the page shows what the demo console enforces", () => {
    expect(SAMPLE_RULES).toEqual(DEMO_POLICY);
  });
});

describe("evaluateGate", () => {
  it("asks the shared rule check, with the visitor's pause switch applied", () => {
    for (const amountCents of [100, 1800, 2000, 2001, 2500, 2501, 4000, 100_000]) {
      for (const category of [Category.Crypto, Category.Sports, Category.Politics] as const) {
        for (const paused of [false, true]) {
          const input = { amountCents, category, paused };
          expect(evaluateGate(input)).toEqual(
            evaluateIntent({ ...SAMPLE_RULES, paused }, SAMPLE_STATE, { category, isBuy: true, amountCents }),
          );
        }
      }
    }
  });

  it("approves up to the approval line, holds above it, and rejects over the max trade", () => {
    expect(evaluateGate(at(1800)).verdict).toBe("approved");
    expect(evaluateGate(at(2000)).verdict).toBe("approved");
    expect(evaluateGate(at(2001)).verdict).toBe("needs_approval");
    expect(evaluateGate(at(2500)).verdict).toBe("needs_approval");
    expect(evaluateGate(at(2501))).toEqual({ verdict: "rejected", reason: "over max trade size" });
  });

  it("rejects a market outside the mandate and anything while paused", () => {
    expect(evaluateGate(at(1800, { category: Category.Sports }))).toEqual({
      verdict: "rejected",
      reason: "category not allowed",
    });
    expect(evaluateGate(at(1800, { paused: true }))).toEqual({ verdict: "rejected", reason: "agent paused" });
  });

  it("checks the pause switch before any other rule, as the contract does", () => {
    expect(evaluateGate(at(3000, { category: Category.Politics, paused: true }))).toEqual({
      verdict: "rejected",
      reason: "agent paused",
    });
  });
});

describe("clampAmount", () => {
  it("keeps the amount in whole cents inside the gate's range", () => {
    expect(clampAmount(0)).toBe(AMOUNT_MIN_CENTS);
    expect(clampAmount(1234.6)).toBe(1235);
    expect(clampAmount(10 ** 12)).toBe(AMOUNT_MAX_CENTS);
    expect(clampAmount(Number.NaN)).toBe(AMOUNT_MIN_CENTS);
  });
});

describe("the schedule", () => {
  it("lists the rules in the order the contract checks them, then the approval line", () => {
    const reasons = scheduleRows(DEFAULT_INPUT).map((row) => row.reason);
    expect(reasons.at(-1)).toBeNull();
    const indexes = reasons.slice(0, -1).map((reason) => REASON_CODES.indexOf(reason ?? "rejected by user"));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes.every((index) => index >= 0)).toBe(true);
  });

  it("closes every breaker for an approved trade", () => {
    expect(new Set(Object.values(states(at(1800))))).toEqual(new Set(["closed"]));
  });

  it("holds only the approval line for a trade above it", () => {
    expect(states(at(2200))).toEqual({
      paused: "closed",
      dailyLoss: "closed",
      maxTrade: "closed",
      markets: "closed",
      budget: "closed",
      approval: "held",
    });
  });

  it("trips the rule that rejected, passes the ones before it and never reaches the rest", () => {
    expect(states(at(3000))).toEqual({
      paused: "closed",
      dailyLoss: "closed",
      maxTrade: "tripped",
      markets: "idle",
      budget: "idle",
      approval: "idle",
    });
    expect(states(at(1800, { category: Category.Sports }))).toMatchObject({
      maxTrade: "closed",
      markets: "tripped",
      budget: "idle",
    });
    expect(states(at(1800, { paused: true }))).toMatchObject({ paused: "tripped", dailyLoss: "idle" });
  });

  it("shows the pause switch's position as its rating", () => {
    const pause = (paused: boolean) => scheduleRows(at(1800, { paused })).find((row) => row.id === "paused");
    expect(pause(false)?.rating).toBe("Off, agent live");
    expect(pause(true)?.rating).toBe("On, agent paused");
  });
});

describe("verdictCopy", () => {
  it("names each verdict and gives the contract's reason only for a rejection", () => {
    expect(verdictCopy(evaluateGate(at(1800)), at(1800))).toMatchObject({
      tone: "approved",
      title: "Approved",
      code: null,
    });
    expect(verdictCopy(evaluateGate(at(2200)), at(2200))).toMatchObject({
      tone: "held",
      title: "Held for your signature",
      detail: expect.stringContaining("$22.00 is above your $20.00 line") as unknown,
      code: null,
    });
    expect(verdictCopy(evaluateGate(at(3000)), at(3000))).toMatchObject({
      tone: "rejected",
      title: "Rejected",
      detail: "$30.00 is over the $25.00 largest single order this mandate allows.",
      code: "over max trade size",
    });
  });

  it("explains every reason the contract can give", () => {
    for (const reason of REASON_CODES) {
      const copy = verdictCopy({ verdict: "rejected", reason }, DEFAULT_INPUT);
      expect(copy.code).toBe(reason);
      expect(copy.detail.length).toBeGreaterThan(10);
    }
  });
});
