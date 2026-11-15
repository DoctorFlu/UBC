import { describe, expect, it } from "vitest";
import {
  CONSOLE_AGENT_ROUTES,
  holdingSchema,
  pairingResponseSchema,
  postPolicyChangeRequestSchema,
  proposedRulesSchema,
  putContextRequestSchema,
} from "../src/console-api";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("console agent API contract", () => {
  it("builds routes under one versioned base path", () => {
    expect(CONSOLE_AGENT_ROUTES.holdings).toBe("/api/agent/v1/holdings");
    expect(CONSOLE_AGENT_ROUTES.context("0xabc")).toBe("/api/agent/v1/contexts/0xabc");
    expect(CONSOLE_AGENT_ROUTES.policyChangeRequest("r1")).toBe("/api/agent/v1/policy-change-requests/r1");
  });

  it("accepts decimal-string quantities and refuses floats, exponents and too many decimals", () => {
    expect(holdingSchema.safeParse({ asset: "BTC", quantity: "0.05" }).success).toBe(true);
    expect(holdingSchema.safeParse({ asset: "BTC", quantity: "12" }).success).toBe(true);
    expect(holdingSchema.safeParse({ asset: "BTC", quantity: 0.05 }).success).toBe(false);
    expect(holdingSchema.safeParse({ asset: "BTC", quantity: "5e-2" }).success).toBe(false);
    expect(holdingSchema.safeParse({ asset: "BTC", quantity: "0.123456789" }).success).toBe(false);
    expect(holdingSchema.safeParse({ asset: "btc", quantity: "1" }).success).toBe(false);
  });

  it("never lets an agent propose a pause or unpause", () => {
    expect(proposedRulesSchema.safeParse({ maxTradeCents: 7500 }).success).toBe(true);
    expect("paused" in proposedRulesSchema.shape).toBe(false);
  });

  it("requires a reason and at least one changed rule on a policy change request", () => {
    const base = { agentAddress: AGENT, proposed: { maxTradeCents: 7500 }, reason: "Rung 3 costs $62." };
    expect(postPolicyChangeRequestSchema.safeParse(base).success).toBe(true);
    expect(postPolicyChangeRequestSchema.safeParse({ ...base, proposed: {} }).success).toBe(false);
    expect(postPolicyChangeRequestSchema.safeParse({ ...base, reason: "  " }).success).toBe(false);
  });

  it("refuses unknown keys so nothing slips past the contract", () => {
    expect(putContextRequestSchema.safeParse({ document: {}, extra: 1 }).success).toBe(false);
    expect(
      pairingResponseSchema.safeParse({
        agentAddress: AGENT,
        agentName: "Grok Bot",
        status: "pending",
        claimUrl: "http://localhost:3000/setup?claim=0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        isContractAgent: false,
      }).success,
    ).toBe(true);
  });
});
