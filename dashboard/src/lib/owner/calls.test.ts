import { policyAbi } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { ownerCallSchema } from "./calls";

/** The contract's writes another key makes: the agent proposes, the executor records results. */
const NOT_THE_OWNERS = new Set(["proposeTrade", "recordResult"]);

/** Every write of the Policy contract only its owner (`user()`) may make, from its ABI. */
const ownerWrites = [
  ...new Set(
    policyAbi.flatMap((item) =>
      item.type === "function" && item.stateMutability === "nonpayable" && !NOT_THE_OWNERS.has(item.name)
        ? [item.name]
        : [],
    ),
  ),
].sort();

/** What each of them takes, enough for the schema to read it if it accepted the name. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  setPolicy: {
    rules: {
      budgetCents: 10_000,
      maxTradeCents: 3_000,
      allowedCategories: 1,
      approvalAboveCents: 2_000,
      dailyLossCents: 0,
      paused: false,
    },
  },
  setPaused: { paused: true },
  approveIntent: { intentId: 0 },
  rejectIntent: { intentId: 0 },
  setUser: { user: "0x000000000000000000000000000000000000dEaD" },
  setAgent: { agent: "0x000000000000000000000000000000000000dEaD" },
  setExecutor: { executor: "0x000000000000000000000000000000000000dEaD" },
};

/**
 * The console signs owner calls with the owner key it holds for a mandate it deployed (#95). Handing a
 * role to another account (v2) is the owner's decision alone, made from their own wallet: the console's
 * owner-call schema must never accept one, whatever a member's passkey confirms.
 */
describe("the owner calls the console signs", () => {
  it("knows every owner write of the contract, so a new one needs a decision here", () => {
    expect(ownerWrites).toEqual([
      "approveIntent",
      "rejectIntent",
      "setAgent",
      "setExecutor",
      "setPaused",
      "setPolicy",
      "setUser",
    ]);
    for (const name of ownerWrites) expect(ARGUMENTS[name], name).toBeDefined();
  });

  it("accepts exactly setPolicy, setPaused, approveIntent and rejectIntent", () => {
    const accepted = ownerWrites.filter(
      (name) => ownerCallSchema.safeParse({ functionName: name, ...ARGUMENTS[name] }).success,
    );
    expect(accepted).toEqual(["approveIntent", "rejectIntent", "setPaused", "setPolicy"]);
  });

  it.each(["setUser", "setAgent", "setExecutor"])("refuses %s, a role setter", (name) => {
    expect(ownerCallSchema.safeParse({ functionName: name, ...ARGUMENTS[name] }).success).toBe(false);
  });
});
