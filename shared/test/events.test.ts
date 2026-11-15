import { describe, expect, it } from "vitest";
import { encodeFunctionData, toEventSignature, toFunctionSignature, type AbiFunction } from "viem";
import {
  decodePolicyLogs,
  EventDecodeError,
  policyAbi,
  policyEventSchema,
  policyFromChain,
  policyToChain,
  UnitError,
  ZERO_HASH,
} from "../src";
import { makeLog, POLICY_ADDRESS } from "./logs";

const CONTEXT: `0x${string}` = `0x${"ab".repeat(32)}`;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("ABI", () => {
  it("keeps the tech spec signatures", () => {
    const signature = (name: string) => {
      const item = policyAbi.find((entry) => "name" in entry && entry.name === name);
      if (!item) throw new Error(`missing ${name}`);
      return item.type === "event" ? toEventSignature(item) : toFunctionSignature(item as AbiFunction);
    };
    expect(signature("setPolicy")).toBe("setPolicy((uint256,uint256,uint256,uint256,uint256,bool))");
    expect(signature("approveIntent")).toBe("approveIntent(uint256)");
    expect(signature("rejectIntent")).toBe("rejectIntent(uint256)");
    expect(signature("setPaused")).toBe("setPaused(bool)");
    expect(signature("recordResult")).toBe("recordResult(uint256,bool,uint256,int256)");
    expect(signature("IntentApproved")).toBe("IntentApproved(uint256,string,string,bool,uint256,uint256)");
    expect(signature("IntentRejected")).toBe("IntentRejected(uint256,string)");
    expect(signature("IntentNeedsApproval")).toBe("IntentNeedsApproval(uint256,uint256)");
    expect(signature("ResultRecorded")).toBe("ResultRecorded(uint256,bool,uint256,int256)");
    // Extension 1: seventh parameter.
    expect(signature("proposeTrade")).toBe("proposeTrade(string,uint8,string,bool,uint256,uint256,bytes32)");
  });

  it("encodes a proposal", () => {
    const data = encodeFunctionData({
      abi: policyAbi,
      functionName: "proposeTrade",
      args: ["GEMI-BTC2611202200-HI65000", 0, "YES", true, 1000n, 65n, ZERO_HASH],
    });
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(data.length).toBeGreaterThan(10 + 64 * 7);
  });
});

describe("decodePolicyLogs", () => {
  it("decodes every event type into typed, JSON-safe events", () => {
    const at = (logIndex: number) => ({ blockNumber: 7, logIndex, blockTimestamp: 1_763_200_000 });
    const chainPolicy = policyToChain({
      budgetCents: 20_000,
      maxTradeCents: 2_500,
      allowedCategories: 1,
      approvalAboveCents: 2_000,
      dailyLossCents: 4_000,
      paused: false,
    });
    const logs = [
      makeLog("PolicySet", { policy: chainPolicy }, at(0)),
      makeLog("PausedSet", { paused: true }, at(1)),
      makeLog(
        "IntentProposed",
        {
          intentId: 1n,
          agent: AGENT,
          market: "GEMI-BTC2611202200-HI65000",
          category: 0,
          outcome: "YES",
          isBuy: true,
          amountCents: 1_000n,
          limitPrice: 65n,
          contextHash: CONTEXT,
        },
        at(2),
      ),
      makeLog(
        "IntentApproved",
        {
          intentId: 1n,
          market: "GEMI-BTC2611202200-HI65000",
          outcome: "YES",
          isBuy: true,
          amountCents: 1_000n,
          limitPrice: 65n,
        },
        at(3),
      ),
      makeLog("IntentNeedsApproval", { intentId: 2n, amountCents: 2_200n }, at(4)),
      makeLog("IntentRejected", { intentId: 3n, reason: "OVER_BUDGET" }, at(5)),
      makeLog("ResultRecorded", { intentId: 1n, filled: true, filledCents: 999n, pnlCents: -250n }, at(6)),
    ];

    const events = decodePolicyLogs(logs);
    expect(events.map((e) => e.type)).toEqual([
      "PolicySet",
      "PausedSet",
      "IntentProposed",
      "IntentApproved",
      "IntentNeedsApproval",
      "IntentRejected",
      "ResultRecorded",
    ]);
    expect(events[0]).toMatchObject({ policy: policyFromChain(chainPolicy), blockNumber: 7, logIndex: 0 });
    expect(events[2]).toMatchObject({
      intentId: 1,
      agent: AGENT,
      amountCents: 1_000,
      limitPrice: 65,
      contextHash: CONTEXT,
    });
    expect(events[6]).toMatchObject({
      filled: true,
      filledCents: 999,
      pnlCents: -250,
      blockTimestamp: 1_763_200_000,
    });

    for (const event of events) {
      expect(policyEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

  it("skips logs from other contracts and unrelated events", () => {
    const other = "0x0000000000000000000000000000000000000001";
    const ours = makeLog("PausedSet", { paused: true }, { blockNumber: 1, logIndex: 0, blockTimestamp: 1 });
    const theirs = makeLog(
      "PausedSet",
      { paused: false },
      { blockNumber: 1, logIndex: 1, blockTimestamp: 1, address: other },
    );
    const foreign = { ...ours, logIndex: 2, topics: [`0x${"11".repeat(32)}`] as [`0x${string}`] };

    expect(decodePolicyLogs([ours, theirs, foreign], { address: POLICY_ADDRESS })).toHaveLength(1);
    expect(decodePolicyLogs([ours, theirs, foreign])).toHaveLength(2);
  });

  it("takes timestamps from the log, else from the lookup, else fails loudly", () => {
    const log = makeLog("PausedSet", { paused: true }, { blockNumber: 9, logIndex: 0 });
    expect(() => decodePolicyLogs([log])).toThrow(EventDecodeError);
    const [event] = decodePolicyLogs([log], { blockTimestamps: new Map([[9n, 1234]]) });
    expect(event?.blockTimestamp).toBe(1234);
  });

  it("refuses values that do not fit a safe integer instead of losing precision", () => {
    const huge = makeLog(
      "IntentNeedsApproval",
      { intentId: 1n, amountCents: 2n ** 60n },
      { blockNumber: 1, logIndex: 0, blockTimestamp: 1 },
    );
    expect(() => decodePolicyLogs([huge])).toThrow(UnitError);
  });
});
