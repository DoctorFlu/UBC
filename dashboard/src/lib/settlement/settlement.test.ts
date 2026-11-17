import { type IntentView, type Settlement, settlementTotals } from "@mandate/shared";
import { describe, expect, it } from "vitest";

import { fixtureSnapshot } from "@/fixtures";
import type { SettlementView } from "@/lib/live/types";

import {
  formatSettlementValue,
  ladderSettlement,
  positionResult,
  settledAtSentence,
  settledLadders,
  tickerAsset,
  totalsSentence,
} from "./settlement";

function doc(intentId: number, patch: Partial<Settlement> = {}): Settlement {
  return {
    version: 1,
    chainId: 31337,
    policy: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    intentId,
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
    ...patch,
  };
}

const verified = (document: Settlement): SettlementView => ({
  status: "verified",
  hash: `0x${"11".repeat(32)}`,
  signer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  signature: `0x${"22".repeat(65)}`,
  storedAt: "2026-11-20T22:01:00.000Z",
  document,
});

describe("settled ladders", () => {
  const settlements: Record<number, SettlementView> = {
    0: verified(doc(0)),
    2: verified(
      doc(2, {
        market: "GEMI-BTC2611202200-HI64000",
        strikeCents: 6_400_000,
        costCents: 2_160,
        limitPrice: 27,
        contractsHundredths: 8_000,
        payoutCents: 0,
        pnlCents: -2_160,
        resolution: "yes",
      }),
    ),
    5: verified(
      doc(5, {
        market: "GEMI-BTC2611132200-HI68500",
        eventTicker: "BTC2611132200",
        strikeCents: 6_850_000,
        expiresAt: "2026-11-13T22:00:00.000Z",
        settlementValue: "68332.8725",
      }),
    ),
    6: verified(
      doc(6, { market: "GEMI-ETH2611202200-HI2800", eventTicker: "ETH2611202200", strikeCents: 280_000 }),
    ),
    // A record whose stored document was edited is never counted.
    7: { status: "tampered", hash: `0x${"33".repeat(32)}`, storedAt: "2026-11-20T22:01:00.000Z" },
  };

  it("groups positions by ladder, newest expiry first, highest strike first, for one asset", () => {
    const ladders = settledLadders({ settlements }, "BTC");
    expect(ladders.map((ladder) => ladder.eventTicker)).toEqual(["BTC2611202200", "BTC2611132200"]);
    const [latest] = ladders;
    expect(latest?.positions.map((position) => position.intentId)).toEqual([0, 2]);
    expect(latest?.totals).toEqual({
      positions: 2,
      costCents: 3_400,
      feeCents: 0,
      payoutCents: 4_000,
      pnlCents: 600,
      feesEstimated: false,
    });
    expect(settledLadders({ settlements }).map((ladder) => ladder.eventTicker)).toEqual([
      "BTC2611202200",
      "ETH2611202200",
      "BTC2611132200",
    ]);
    expect(settledLadders(null)).toEqual([]);
  });

  it("says what happened in plain words", () => {
    const [latest] = settledLadders({ settlements }, "BTC");
    if (latest === undefined) throw new Error("no ladder");
    expect(settledAtSentence(latest)).toBe("BTC settled at $64,992.86, so 1 of the 2 positions paid out.");
    expect(totalsSentence(latest.totals)).toBe("It cost $34.00 and paid $40.00: a net gain of $6.00.");
    const none = { feeCents: 0, feesEstimated: false };
    expect(
      totalsSentence({ positions: 1, costCents: 2_160, payoutCents: 0, pnlCents: -2_160, ...none }),
    ).toBe("It cost $21.60 and paid nothing, so the protection cost $21.60.");
    expect(
      totalsSentence({ positions: 2, costCents: 3_000, payoutCents: 1_000, pnlCents: -2_000, ...none }),
    ).toBe("It cost $30.00 and paid $10.00: a net cost of $20.00.");
  });

  it("counts Gemini's estimated fee in the net and says once that it is estimated", () => {
    // The sandbox fill: 97c and a 1c fee, paid $1.00.
    const fee = { costCents: 97, feeCents: 1, payoutCents: 100, pnlCents: 2 };
    expect(settlementTotals([fee])).toEqual({ positions: 1, ...fee, feesEstimated: true });
    expect(totalsSentence(settlementTotals([fee]))).toBe(
      "It cost $0.97 and $0.01 in fees (estimated) and paid $1.00: a net gain of $0.02.",
    );
    expect(totalsSentence(settlementTotals([{ costCents: 97, feeCents: 1, payoutCents: 0 }]))).toBe(
      "It cost $0.97 and $0.01 in fees (estimated) and paid nothing, so the protection cost $0.98.",
    );
    // A simulated fill has no fee: nothing is estimated.
    expect(settlementTotals([{ costCents: 97, payoutCents: 100 }])).toMatchObject({
      feeCents: 0,
      pnlCents: 3,
      feesEstimated: false,
    });
  });

  it("gives every intent one result: none, open until expiry, waiting, or the settlement's net after fees", () => {
    const filled = {
      status: "executed" as const,
      isBuy: true,
      filledCents: 97,
      market: "GEMI-BTC2611171700-HI64500",
    };
    const before = Date.parse("2026-11-17T16:30:00Z");
    const after = Date.parse("2026-11-17T17:00:30Z");
    expect(positionResult(filled, undefined, before)).toEqual({
      kind: "open",
      expiresAt: "2026-11-17T17:00:00.000Z",
      settles: "Nov 17, 17:00 UTC",
    });
    expect(positionResult(filled, undefined, null)).toMatchObject({ kind: "open" });
    expect(positionResult(filled, undefined, after)).toEqual({
      kind: "awaiting",
      expiresAt: "2026-11-17T17:00:00.000Z",
    });
    expect(positionResult({ ...filled, filledCents: 0 }, undefined, after)).toEqual({ kind: "none" });
    expect(positionResult({ ...filled, status: "approved", filledCents: null }, undefined, after)).toEqual({
      kind: "none",
    });
    expect(positionResult({ ...filled, isBuy: false }, undefined, after)).toEqual({ kind: "sold" });
    const [stored] = Object.values(settlements);
    if (stored?.status !== "verified") throw new Error("the fixture has a verified settlement");
    const document = { ...stored.document, feeCents: 1, pnlCents: stored.document.pnlCents - 1 };
    expect(positionResult(filled, { ...stored, document }, after)).toEqual({
      kind: "settled",
      netCents: document.pnlCents,
      feeCents: 1,
      payoutCents: document.payoutCents,
    });
    const tampered: SettlementView = { status: "tampered", hash: stored.hash, storedAt: stored.storedAt };
    expect(positionResult(filled, tampered, after)).toEqual({
      kind: "unverified",
    });
  });

  it("says where an expired plan's ladder stands: open, waiting, partly or fully settled", () => {
    const chain = fixtureSnapshot.chain;
    if (!chain) throw new Error("the fixture has a chain");
    // Intents 0 (HI66000, $12.40) and 1 (HI65000, $13.20) are filled on BTC2611202200.
    const ladder = { eventTicker: "BTC2611202200", expiry: "2026-11-20T22:00:00.000Z" };
    const before = Date.parse("2026-11-20T21:59:00.000Z");
    const after = Date.parse("2026-11-20T22:01:00.000Z");
    expect(ladderSettlement(chain, ladder, before)).toEqual({ state: "open" });
    expect(ladderSettlement(chain, ladder, null)).toEqual({ state: "open" });
    expect(ladderSettlement(chain, ladder, after)).toEqual({
      state: "settling",
      expiresAt: ladder.expiry,
      waiting: 2,
      ladder: null,
    });
    const first = verified(doc(0, { market: "GEMI-BTC2611202200-HI66000", strikeCents: 6_600_000 }));
    const partly = ladderSettlement({ ...chain, settlements: { 0: first } }, ladder, null);
    expect(partly).toMatchObject({ state: "settling", waiting: 1, ladder: { totals: { positions: 1 } } });
    const both = ladderSettlement(
      {
        ...chain,
        settlements: {
          0: first,
          1: verified(
            doc(1, {
              costCents: 1_320,
              limitPrice: 22,
              contractsHundredths: 6_000,
              payoutCents: 6_000,
              pnlCents: 4_680,
            }),
          ),
        },
      },
      ladder,
      null,
    );
    expect(both).toMatchObject({
      state: "settled",
      ladder: { totals: { positions: 2, payoutCents: 10_000 } },
    });
    const nothing: IntentView[] = chain.intents.filter((intent) => intent.status !== "executed");
    expect(ladderSettlement({ intents: nothing, settlements: {} }, ladder, after)).toEqual({
      state: "nothing_filled",
      expiresAt: ladder.expiry,
    });
  });

  it("reads Gemini's tickers and settlement levels", () => {
    expect(tickerAsset("BTC2611202200")).toBe("BTC");
    expect(tickerAsset("ETH15M2611170400")).toBe("ETH");
    expect(tickerAsset("NFL-2611152125-SF-DAL-M")).toBeNull();
    expect(formatSettlementValue("64992.864")).toBe("$64,992.86");
    expect(formatSettlementValue("68332.8765")).toBe("$68,332.88");
    expect(formatSettlementValue("1817")).toBe("$1,817.00");
    expect(formatSettlementValue("not a number")).toBeNull();
    expect(formatSettlementValue(null)).toBeNull();
  });
});
