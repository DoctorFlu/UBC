import { describe, expect, it } from "vitest";
import {
  CONSOLE_AGENT_ROUTES,
  holdingSchema,
  intentContextResponseSchema,
  pairingResponseSchema,
  postPolicyChangeRequestSchema,
  proposedRulesSchema,
  putContextRequestSchema,
  putIntentContextRequestSchema,
  putSignalBudgetRequestSchema,
  putSignalPaymentRequestSchema,
  signalBudgetResponseSchema,
  signalPaymentResponseSchema,
  usdcAtomicSchema,
} from "../src/console-api";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("console agent API contract", () => {
  it("builds routes under one versioned base path", () => {
    expect(CONSOLE_AGENT_ROUTES.holdings).toBe("/api/agent/v1/holdings");
    expect(CONSOLE_AGENT_ROUTES.context("0xabc")).toBe("/api/agent/v1/contexts/0xabc");
    expect(CONSOLE_AGENT_ROUTES.policyChangeRequest("r1")).toBe("/api/agent/v1/policy-change-requests/r1");
    expect(CONSOLE_AGENT_ROUTES.intentContext(7)).toBe("/api/agent/v1/intents/7/context");
  });

  it("links an intent to a context hash with a strict body", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const txHash = `0x${"cd".repeat(32)}`;
    expect(putIntentContextRequestSchema.safeParse({ hash, txHash }).success).toBe(true);
    expect(putIntentContextRequestSchema.safeParse({ hash }).success).toBe(false);
    expect(putIntentContextRequestSchema.safeParse({ hash, txHash, intentId: 1 }).success).toBe(false);
    expect(putIntentContextRequestSchema.safeParse({ hash: "0x12", txHash }).success).toBe(false);
    const link = { intentId: 0, hash, txHash, linkedAt: "2026-11-15T13:24:41.000Z" };
    expect(intentContextResponseSchema.safeParse(link).success).toBe(true);
    expect(intentContextResponseSchema.safeParse({ ...link, intentId: -1 }).success).toBe(false);
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

  describe("signal payments (issue #22)", () => {
    const receiptId = `0x${"ab".repeat(32)}`;
    const payment = {
      amount: "1000",
      paidAt: "2026-11-15T12:00:01.000Z",
      resource: "/v1/signal/hedge?asset=BTC&horizon=weekly",
      network: "eip155:5042002",
      payer: AGENT,
      payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      settlementId: "9b1f2d1e-5d55-4c4e-8f61-0b2a3c4d5e6f",
      signal: {
        signalId: `0x${"cd".repeat(32)}`,
        asset: "BTC",
        eventTicker: "BTC2611202200",
        horizon: "weekly",
        expiry: "2026-11-20T22:00:00.000Z",
        asOf: "2026-11-15T12:00:00.000Z",
        counts: { cheap: 3, fair: 15, expensive: 3, noOffer: 0 },
      },
    };
    const budget = {
      buyerAddress: AGENT,
      day: "2026-11-15",
      dailyBudget: "20000",
      spentToday: "1000",
      maxPricePerPurchase: "5000",
      resetsAt: "2026-11-16T00:00:00.000Z",
      gatewayBalance: "4999000",
      asOf: "2026-11-15T12:00:02.000Z",
    };

    it("builds the routes under the same base path", () => {
      expect(CONSOLE_AGENT_ROUTES.signalPayment(receiptId)).toBe(
        `/api/agent/v1/signal-payments/${receiptId}`,
      );
      expect(CONSOLE_AGENT_ROUTES.signalBudget).toBe("/api/agent/v1/signal-budget");
    });

    it("carries USDC as integer atomic units in decimal strings, never floats or formatted amounts", () => {
      for (const ok of ["0", "1", "1000", "123456789012"])
        expect(usdcAtomicSchema.safeParse(ok).success).toBe(true);
      for (const bad of [1000, "0.001", "1e3", "-1", "01", " 1", ""]) {
        expect(usdcAtomicSchema.safeParse(bad).success).toBe(false);
      }
      expect(putSignalPaymentRequestSchema.safeParse({ ...payment, amount: 0.001 }).success).toBe(false);
      expect(putSignalBudgetRequestSchema.safeParse({ ...budget, spentToday: "0.001" }).success).toBe(false);
    });

    it("accepts a payment record, and one whose signal or seller details are unknown", () => {
      expect(putSignalPaymentRequestSchema.safeParse(payment).success).toBe(true);
      expect(
        putSignalPaymentRequestSchema.safeParse({ ...payment, signal: null, payee: null, settlementId: null })
          .success,
      ).toBe(true);
      expect(putSignalPaymentRequestSchema.safeParse({ ...payment, resource: "http://x/v1" }).success).toBe(
        false,
      );
      expect(signalPaymentResponseSchema.safeParse({ receiptId, recordedAt: payment.paidAt }).success).toBe(
        true,
      );
      expect(
        signalPaymentResponseSchema.safeParse({ receiptId: "0x12", recordedAt: payment.paidAt }).success,
      ).toBe(false);
    });

    it("refuses any field that could carry a secret, such as a signature or a key", () => {
      expect(putSignalPaymentRequestSchema.safeParse({ ...payment, signature: "0xdead" }).success).toBe(
        false,
      );
      expect(putSignalPaymentRequestSchema.safeParse({ ...payment, receiptId }).success).toBe(false);
      expect(putSignalBudgetRequestSchema.safeParse({ ...budget, privateKey: "0x01" }).success).toBe(false);
    });

    it("accepts a budget snapshot with or without a known Gateway balance", () => {
      expect(putSignalBudgetRequestSchema.safeParse(budget).success).toBe(true);
      expect(putSignalBudgetRequestSchema.safeParse({ ...budget, gatewayBalance: null }).success).toBe(true);
      expect(putSignalBudgetRequestSchema.safeParse({ ...budget, day: "15/11/2026" }).success).toBe(false);
      expect(putSignalBudgetRequestSchema.safeParse({ ...budget, buyerAddress: "0x12" }).success).toBe(false);
      const stored = { ...budget, storedAt: "2026-11-15T12:00:03.000Z" };
      expect(signalBudgetResponseSchema.safeParse(stored).success).toBe(true);
      expect(signalBudgetResponseSchema.safeParse({ ...stored, extra: 1 }).success).toBe(false);
    });
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
