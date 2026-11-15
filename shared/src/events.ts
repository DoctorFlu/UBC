import { isAddressEqual, parseEventLogs, type Address, type Log } from "viem";
import { policyAbi } from "./abi";
import type { EventMeta, PolicyEvent, PolicyRules } from "./types";
import { toSafeNumber } from "./units";

export interface DecodeOptions {
  /** Only decode logs emitted by this contract. Recommended whenever logs may come from other contracts. */
  address?: Address;
  /**
   * Unix seconds per block number, for logs whose RPC did not include `blockTimestamp`.
   * `PolicyClient.getEvents` fills this in automatically.
   */
  blockTimestamps?: ReadonlyMap<bigint, number>;
}

export class EventDecodeError extends Error {
  override name = "EventDecodeError";
}

/**
 * Decodes viem logs (already formatted, as returned by `getLogs` or a receipt) into typed Policy events.
 * Logs that are not Policy events are skipped. Raw RPC logs must be formatted with viem's `formatLog` first.
 */
export function decodePolicyLogs(logs: readonly Log[], options: DecodeOptions = {}): PolicyEvent[] {
  const { address, blockTimestamps } = options;
  const relevant = address ? logs.filter((log) => isAddressEqual(log.address, address)) : logs;
  const parsed = parseEventLogs({ abi: policyAbi, logs: [...relevant], strict: true });

  return parsed.map((log): PolicyEvent => {
    const timestamp = log.blockTimestamp ?? null;
    const seconds = timestamp !== null ? Number(timestamp) : blockTimestamps?.get(log.blockNumber);
    if (seconds === undefined) {
      throw new EventDecodeError(
        `no block timestamp for block ${log.blockNumber}; pass options.blockTimestamps`,
      );
    }
    const meta: EventMeta = {
      blockNumber: toSafeNumber(log.blockNumber, "blockNumber"),
      blockTimestamp: seconds,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    };

    switch (log.eventName) {
      case "IntentProposed":
        return {
          ...meta,
          type: "IntentProposed",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          agent: log.args.agent,
          market: log.args.market,
          category: log.args.category,
          outcome: log.args.outcome,
          isBuy: log.args.isBuy,
          amountCents: toSafeNumber(log.args.amountCents, "amountCents"),
          limitPrice: toSafeNumber(log.args.limitPrice, "limitPrice"),
          contextHash: log.args.contextHash,
        };
      case "IntentApproved":
        return {
          ...meta,
          type: "IntentApproved",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          market: log.args.market,
          outcome: log.args.outcome,
          isBuy: log.args.isBuy,
          amountCents: toSafeNumber(log.args.amountCents, "amountCents"),
          limitPrice: toSafeNumber(log.args.limitPrice, "limitPrice"),
        };
      case "IntentRejected":
        return {
          ...meta,
          type: "IntentRejected",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          reason: log.args.reason,
        };
      case "IntentNeedsApproval":
        return {
          ...meta,
          type: "IntentNeedsApproval",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          amountCents: toSafeNumber(log.args.amountCents, "amountCents"),
        };
      case "ResultRecorded":
        return {
          ...meta,
          type: "ResultRecorded",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          filled: log.args.filled,
          filledCents: toSafeNumber(log.args.filledCents, "filledCents"),
          pnlCents: toSafeNumber(log.args.pnlCents, "pnlCents"),
        };
      case "PolicyUpdated":
        return { ...meta, type: "PolicyUpdated", rules: rulesFromChain(log.args) };
      case "Paused":
        return { ...meta, type: "Paused", paused: log.args.paused };
    }
  });
}

/** The rules as the contract returns or emits them, with uint256 fields as bigints. */
export interface ChainPolicyRules {
  budgetCents: bigint;
  maxTradeCents: bigint;
  allowedCategories: bigint;
  approvalAboveCents: bigint;
  dailyLossCents: bigint;
  paused: boolean;
}

export function rulesFromChain(p: ChainPolicyRules): PolicyRules {
  return {
    budgetCents: toSafeNumber(p.budgetCents, "budgetCents"),
    maxTradeCents: toSafeNumber(p.maxTradeCents, "maxTradeCents"),
    allowedCategories: toSafeNumber(p.allowedCategories, "allowedCategories"),
    approvalAboveCents: toSafeNumber(p.approvalAboveCents, "approvalAboveCents"),
    dailyLossCents: toSafeNumber(p.dailyLossCents, "dailyLossCents"),
    paused: p.paused,
  };
}

/** The `policy()` getter returns the fields as a tuple, in struct order. */
export function rulesFromTuple(
  tuple: readonly [bigint, bigint, bigint, bigint, bigint, boolean],
): PolicyRules {
  const [budgetCents, maxTradeCents, allowedCategories, approvalAboveCents, dailyLossCents, paused] = tuple;
  return rulesFromChain({
    budgetCents,
    maxTradeCents,
    allowedCategories,
    approvalAboveCents,
    dailyLossCents,
    paused,
  });
}

export function rulesToChain(p: PolicyRules): ChainPolicyRules {
  return {
    budgetCents: BigInt(p.budgetCents),
    maxTradeCents: BigInt(p.maxTradeCents),
    allowedCategories: BigInt(p.allowedCategories),
    approvalAboveCents: BigInt(p.approvalAboveCents),
    dailyLossCents: BigInt(p.dailyLossCents),
    paused: p.paused,
  };
}

/** Total order of events on chain: block number, then log index. */
export function compareEvents(a: EventMeta, b: EventMeta): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/** Identity of an event, for deduplication. */
export function eventKey(e: Pick<EventMeta, "transactionHash" | "logIndex">): string {
  return `${e.transactionHash.toLowerCase()}:${e.logIndex}`;
}
