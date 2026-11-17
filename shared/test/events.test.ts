import { describe, expect, it } from "vitest";
import { encodeFunctionData, toEventSignature, toFunctionSignature, type AbiFunction } from "viem";
import {
  decodePolicyLogs,
  EventDecodeError,
  policyAbi,
  policyBaseAbi,
  policyEventSchema,
  policyExtensionsAbi,
  policyReferenceAbi,
  policyV2Abi,
  rulesFromChain,
  rulesFromTuple,
  rulesToChain,
  UnitError,
  ZERO_HASH,
} from "../src";
import { makeLog, POLICY_ADDRESS } from "./logs";

const CONTEXT: `0x${string}` = `0x${"ab".repeat(32)}`;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function signatures(abi: readonly { type: string }[]): string[] {
  return abi
    .map((item) => {
      if (item.type === "event") return toEventSignature(item as never);
      if (item.type === "function") return toFunctionSignature(item as AbiFunction);
      return null;
    })
    .filter((s): s is string => s !== null);
}

describe("ABI", () => {
  it("keeps the spec's write functions and events in the base ABI", () => {
    const base = signatures(policyBaseAbi);
    expect(base).toEqual(
      expect.arrayContaining([
        "setPolicy((uint256,uint256,uint256,uint256,uint256,bool))",
        "approveIntent(uint256)",
        "rejectIntent(uint256)",
        "setPaused(bool)",
        "proposeTrade(string,uint8,string,bool,uint256,uint256)",
        "recordResult(uint256,bool,uint256,int256)",
        "IntentApproved(uint256,string,string,bool,uint256,uint256)",
        "IntentRejected(uint256,string)",
        "IntentNeedsApproval(uint256,uint256)",
        "ResultRecorded(uint256,bool,uint256,int256)",
        "PolicyUpdated(uint256,uint256,uint256,uint256,uint256,bool)",
        "Paused(bool)",
      ]),
    );
  });

  it("keeps the extensions separate and additive", () => {
    expect(signatures(policyExtensionsAbi)).toEqual([
      "IntentProposed(uint256,address,string,uint8,string,bool,uint256,uint256,bytes32)",
      "proposeTrade(string,uint8,string,bool,uint256,uint256,bytes32)",
      "previewTrade(uint8,bool,uint256)",
    ]);
    const base = new Set(signatures(policyBaseAbi));
    for (const extension of signatures(policyExtensionsAbi)) expect(base.has(extension)).toBe(false);
    expect(policyReferenceAbi).toHaveLength(policyBaseAbi.length + policyExtensionsAbi.length);
  });

  it("adds only v2's role handover, role events and zero-address error on top, in policyAbi", () => {
    expect(signatures(policyV2Abi)).toEqual([
      "setUser(address)",
      "UserChanged(address,address)",
      "AgentChanged(address,address)",
      "ExecutorChanged(address,address)",
    ]);
    expect(policyAbi).toHaveLength(policyBaseAbi.length + policyExtensionsAbi.length + policyV2Abi.length);
  });

  it("encodes both proposeTrade overloads", () => {
    const base = ["GEMI-BTC2611202200-HI65000", 0, "YES", true, 1000n, 65n] as const;
    const six = encodeFunctionData({ abi: policyAbi, functionName: "proposeTrade", args: base });
    const seven = encodeFunctionData({
      abi: policyAbi,
      functionName: "proposeTrade",
      args: [...base, ZERO_HASH],
    });
    expect(six.slice(0, 10)).not.toBe(seven.slice(0, 10));
  });
});

describe("rules conversions", () => {
  it("round-trips through the chain's struct and the policy() tuple", () => {
    const rules = {
      budgetCents: 20_000,
      maxTradeCents: 2_500,
      allowedCategories: 1,
      approvalAboveCents: 2_000,
      dailyLossCents: 4_000,
      paused: true,
    };
    expect(rulesFromChain(rulesToChain(rules))).toEqual(rules);
    expect(rulesFromTuple([20_000n, 2_500n, 1n, 2_000n, 4_000n, true])).toEqual(rules);
  });
});

describe("decodePolicyLogs", () => {
  it("decodes every event type into typed, JSON-safe events", () => {
    const at = (logIndex: number) => ({ blockNumber: 7, logIndex, blockTimestamp: 1_763_200_000 });
    const chainRules = rulesToChain({
      budgetCents: 20_000,
      maxTradeCents: 2_500,
      allowedCategories: 1,
      approvalAboveCents: 2_000,
      dailyLossCents: 4_000,
      paused: false,
    });
    const logs = [
      makeLog("PolicyUpdated", chainRules, at(0)),
      makeLog("Paused", { paused: true }, at(1)),
      makeLog(
        "IntentProposed",
        {
          intentId: 0n,
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
          intentId: 0n,
          market: "GEMI-BTC2611202200-HI65000",
          outcome: "YES",
          isBuy: true,
          amountCents: 1_000n,
          limitPrice: 65n,
        },
        at(3),
      ),
      makeLog("IntentNeedsApproval", { intentId: 1n, amountCents: 2_200n }, at(4)),
      makeLog("IntentRejected", { intentId: 2n, reason: "over budget" }, at(5)),
      makeLog("ResultRecorded", { intentId: 0n, filled: true, filledCents: 999n, pnlCents: -250n }, at(6)),
    ];

    const events = decodePolicyLogs(logs);
    expect(events.map((e) => e.type)).toEqual([
      "PolicyUpdated",
      "Paused",
      "IntentProposed",
      "IntentApproved",
      "IntentNeedsApproval",
      "IntentRejected",
      "ResultRecorded",
    ]);
    expect(events[0]).toMatchObject({ rules: rulesFromChain(chainRules), blockNumber: 7, logIndex: 0 });
    expect(events[2]).toMatchObject({
      intentId: 0,
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

  it("decodes the role events of Policy v2 under the contract's own names", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const logs = (["UserChanged", "AgentChanged", "ExecutorChanged"] as const).map((name, i) =>
      makeLog(name, { previous: zero, current: AGENT }, { blockNumber: 1, logIndex: i, blockTimestamp: 1 }),
    );
    const decoded = decodePolicyLogs(logs).map((e) => policyEventSchema.parse(e));
    expect(
      decoded.map((e) => [e.type, "previous" in e ? e.previous : null, "current" in e ? e.current : null]),
    ).toEqual([
      ["UserChanged", zero, AGENT],
      ["AgentChanged", zero, AGENT],
      ["ExecutorChanged", zero, AGENT],
    ]);
  });

  it("skips logs from other contracts and unrelated events", () => {
    const other = "0x0000000000000000000000000000000000000001";
    const ours = makeLog("Paused", { paused: true }, { blockNumber: 1, logIndex: 0, blockTimestamp: 1 });
    const theirs = makeLog(
      "Paused",
      { paused: false },
      { blockNumber: 1, logIndex: 1, blockTimestamp: 1, address: other },
    );
    const foreign = { ...ours, logIndex: 2, topics: [`0x${"11".repeat(32)}`] as [`0x${string}`] };

    expect(decodePolicyLogs([ours, theirs, foreign], { address: POLICY_ADDRESS })).toHaveLength(1);
    expect(decodePolicyLogs([ours, theirs, foreign])).toHaveLength(2);
  });

  it("takes timestamps from the log, else from the lookup, else fails loudly", () => {
    const log = makeLog("Paused", { paused: true }, { blockNumber: 9, logIndex: 0 });
    expect(() => decodePolicyLogs([log])).toThrow(EventDecodeError);
    const [event] = decodePolicyLogs([log], { blockTimestamps: new Map([[9n, 1234]]) });
    expect(event?.blockTimestamp).toBe(1234);
  });

  it("keeps an event whose numbers do not fit, flags them exactly, and never rounds or clamps", () => {
    const max = 2n ** 256n - 1n;
    const at = (logIndex: number) => ({ blockNumber: 1, logIndex, blockTimestamp: 1 });
    const decoded = decodePolicyLogs([
      makeLog(
        "IntentProposed",
        {
          intentId: 0n,
          agent: AGENT,
          market: "",
          category: 200,
          outcome: "MAYBE",
          isBuy: true,
          amountCents: max,
          limitPrice: 2n ** 53n,
          contextHash: ZERO_HASH,
        },
        at(0),
      ),
      makeLog(
        "IntentApproved",
        { intentId: 1n, market: "m", outcome: "NO", isBuy: false, amountCents: 100n, limitPrice: max },
        at(1),
      ),
      makeLog("IntentNeedsApproval", { intentId: 2n, amountCents: 2n ** 60n }, at(2)),
      makeLog(
        "ResultRecorded",
        { intentId: 1n, filled: true, filledCents: 100n, pnlCents: -(2n ** 255n) },
        at(3),
      ),
      makeLog("IntentRejected", { intentId: 0n, reason: "over max trade size" }, at(4)),
    ]);
    expect(decoded).toHaveLength(5);
    expect(decoded[0]).toMatchObject({
      type: "IntentProposed",
      amountCents: null,
      limitPrice: null,
      outOfRange: { amountCents: max.toString(), limitPrice: (2n ** 53n).toString() },
    });
    expect(decoded[1]).toMatchObject({
      amountCents: 100,
      limitPrice: null,
      outOfRange: { limitPrice: max.toString() },
    });
    expect(decoded[2]).toMatchObject({
      amountCents: null,
      outOfRange: { amountCents: (2n ** 60n).toString() },
    });
    expect(decoded[3]).toMatchObject({
      filledCents: 100,
      pnlCents: null,
      outOfRange: { pnlCents: (-(2n ** 255n)).toString() },
    });
    expect(decoded[4]).not.toHaveProperty("outOfRange");
    for (const event of decoded) expect(policyEventSchema.parse(event)).toEqual(event);
    // The largest exact value still decodes as a number.
    const edge = makeLog("IntentNeedsApproval", { intentId: 3n, amountCents: 2n ** 53n - 1n }, at(5));
    expect(decodePolicyLogs([edge])[0]).toEqual(expect.objectContaining({ amountCents: 2 ** 53 - 1 }));
    expect(decodePolicyLogs([edge])[0]).not.toHaveProperty("outOfRange");
  });

  it("still refuses rules that do not fit: only the owner's key writes them", () => {
    expect(() =>
      rulesFromChain({ ...rulesToChain(RULES_FOR_RANGE_TEST), budgetCents: 2n ** 256n - 1n }),
    ).toThrow(UnitError);
  });

  it("skips and reports such a rules event when the reader asks to keep moving", () => {
    const at = (logIndex: number) => ({ blockNumber: 7, logIndex, blockTimestamp: 1_700_000_000 });
    const huge = { ...rulesToChain(RULES_FOR_RANGE_TEST), budgetCents: 2n ** 256n - 1n };
    const logs = [makeLog("PolicyUpdated", huge, at(0)), makeLog("Paused", { paused: true }, at(1))];
    expect(() => decodePolicyLogs(logs)).toThrow(UnitError);
    const skipped: number[] = [];
    const events = decodePolicyLogs(logs, { onUndecodable: (log) => skipped.push(log.logIndex ?? -1) });
    expect(events.map((event) => event.type)).toEqual(["Paused"]);
    expect(skipped).toEqual([0]);
  });
});

const RULES_FOR_RANGE_TEST = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: 1,
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};
