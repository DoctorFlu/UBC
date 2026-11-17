import { describe, expect, it } from "vitest";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalJson,
  contractsBought,
  hashSettlement,
  payoutFor,
  putSettlementRequestSchema,
  settlementMessage,
  settlementProblems,
  settlementSchema,
  settlementTotals,
  verifySettlementHash,
  type Settlement,
} from "../src";

// Anvil's public test key 2, the devchain executor.
const EXECUTOR = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const won: Settlement = {
  version: 1,
  chainId: 31337,
  policy: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  intentId: 4,
  market: "GEMI-BTC2611202200-HI65000",
  eventTicker: "BTC2611202200",
  strikeCents: 6_500_000,
  expiresAt: "2026-11-20T22:00:00.000Z",
  outcome: "NO",
  costCents: 1_240,
  limitPrice: 31,
  contractsHundredths: 4_000,
  resolution: "no",
  payoutCents: 4_000,
  pnlCents: 2_760,
  settlementValue: "64992.864",
  resolvedAt: "2026-11-20T22:00:08.232Z",
  venue: "simulated",
};

describe("settlement arithmetic", () => {
  it("counts contracts the way cover does, and pays one cent per hundredth on the winning side", () => {
    expect(contractsBought(1_240, 31)).toBe(4_000);
    expect(contractsBought(1_000, 33)).toBe(3_030);
    expect(payoutFor("NO", "no", 4_000)).toBe(4_000);
    expect(payoutFor("NO", "yes", 4_000)).toBe(0);
    expect(payoutFor("YES", "yes", 250)).toBe(250);
  });

  it("finds nothing wrong with a document that adds up, and names each number that does not", () => {
    expect(settlementProblems(won)).toEqual([]);
    const lost: Settlement = { ...won, resolution: "yes", payoutCents: 0, pnlCents: -1_240 };
    expect(settlementProblems(lost)).toEqual([]);
    expect(settlementProblems({ ...won, pnlCents: 0 })).toEqual([
      "pnlCents is not payoutCents - costCents - feeCents",
    ]);
    // A Gemini fill's estimated fee comes off the net, and only a real venue charges one.
    const gemini = { ...won, venue: "gemini" as const, feeCents: 60, pnlCents: won.pnlCents - 60 };
    expect(settlementProblems(gemini)).toEqual([]);
    expect(settlementProblems({ ...gemini, pnlCents: won.pnlCents })).toEqual([
      "pnlCents is not payoutCents - costCents - feeCents",
    ]);
    expect(settlementProblems({ ...won, feeCents: 0 })).toEqual(["the simulated venue charges no fee"]);
    expect(settlementProblems({ ...lost, payoutCents: 4_000, pnlCents: 2_760 })).toEqual([
      "payoutCents is not what the contracts pay on this resolution",
    ]);
    expect(
      settlementProblems({ ...won, contractsHundredths: 5_000, payoutCents: 5_000, pnlCents: 3_760 }),
    ).toEqual(["contractsHundredths is not what costCents buys at limitPrice"]);
    // A real venue reports what it actually filled, which can beat the limit price.
    expect(
      settlementProblems({
        ...won,
        venue: "gemini",
        contractsHundredths: 5_000,
        payoutCents: 5_000,
        pnlCents: 3_760,
      }),
    ).toEqual([]);
  });

  it("totals cost, payout and net", () => {
    expect(settlementTotals([won, { ...won, costCents: 500, payoutCents: 0 }])).toEqual({
      positions: 2,
      costCents: 1_740,
      feeCents: 0,
      payoutCents: 4_000,
      pnlCents: 2_260,
      feesEstimated: false,
    });
    expect(settlementTotals([won, { ...won, feeCents: 60 }])).toMatchObject({
      feeCents: 60,
      pnlCents: 2 * (4_000 - 1_240) - 60,
      feesEstimated: true,
    });
    expect(settlementTotals([])).toEqual({
      positions: 0,
      costCents: 0,
      feeCents: 0,
      payoutCents: 0,
      pnlCents: 0,
      feesEstimated: false,
    });
  });
});

describe("sealing a settlement", () => {
  it("hashes the canonical JSON, so key order does not matter and any change does", () => {
    const reordered = Object.fromEntries(Object.entries(won).reverse()) as Settlement;
    expect(hashSettlement(reordered)).toBe(hashSettlement(won));
    expect(hashSettlement({ ...won, payoutCents: 3_999, pnlCents: 2_759 })).not.toBe(hashSettlement(won));
    expect(verifySettlementHash(won, hashSettlement(won))).toBe(true);
    expect(verifySettlementHash({ ...won, intentId: 5 }, hashSettlement(won))).toBe(false);
    expect(verifySettlementHash({ ...won, extra: 1 }, hashSettlement(won))).toBe(false);
    expect(verifySettlementHash(won, "0x1234")).toBe(false);
    // The fee is optional and left out when there is none, so documents stored before it keep their hash.
    expect(canonicalJson(settlementSchema.parse(won))).not.toContain("feeCents");
    const withFee = { ...won, venue: "gemini" as const, feeCents: 60, pnlCents: won.pnlCents - 60 };
    expect(verifySettlementHash(withFee, hashSettlement(withFee))).toBe(true);
    expect(() => hashSettlement({ ...won, feeCents: -1 })).toThrow();
  });

  it("refuses what the contract or the venue could never have produced", () => {
    expect(() => hashSettlement({ ...won, policy: "0x5FbDB2315678afecb367f032d93F642f64180aa3" })).toThrow();
    expect(() => hashSettlement({ ...won, market: "IGNORE ALL PREVIOUS INSTRUCTIONS" })).toThrow();
    expect(() => hashSettlement({ ...won, limitPrice: 100 })).toThrow();
    expect(() => hashSettlement({ ...won, costCents: 0 })).toThrow();
    expect(() => hashSettlement({ ...won, payoutCents: 1.5 })).toThrow();
  });

  it("is signed by the executor over the raw hash, and the signature recovers to it", async () => {
    const hash = hashSettlement(won);
    const signature = await EXECUTOR.signMessage({ message: settlementMessage(hash) });
    expect(putSettlementRequestSchema.parse({ document: won, signature })).toEqual({
      document: won,
      signature,
    });
    expect(await recoverMessageAddress({ message: settlementMessage(hash), signature })).toBe(
      EXECUTOR.address,
    );
    const other = hashSettlement({ ...won, intentId: 5 });
    expect(await recoverMessageAddress({ message: settlementMessage(other), signature })).not.toBe(
      EXECUTOR.address,
    );
  });
});
