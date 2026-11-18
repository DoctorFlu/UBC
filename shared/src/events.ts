import {
  AbiEventSignatureEmptyTopicsError,
  AbiEventSignatureNotFoundError,
  decodeEventLog,
  DecodeLogDataMismatch,
  DecodeLogTopicsMismatch,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Log,
  type ParseEventLogsReturnType,
} from "viem";
import { policyAbi, type PolicyAbi } from "./abi";
import type { EventMeta, PolicyEvent, PolicyRules } from "./types";
import { chainNumber, toSafeNumber, UnitError } from "./units";

export interface ParseOptions {
  /**
   * The Policy contract's address. Only its logs are read, and every one of them is accounted for: a log
   * this ABI cannot read is reported (or throws), never dropped. Without it, logs may be any contract's, so
   * a log that is not a Policy event is skipped. Set it whenever the contract is known.
   */
  address?: Address;
  /**
   * Called for a log of the Policy contract that offchain code cannot read: an event this ABI does not know,
   * data that does not match its event (both mean the contract is not the one this code was built for), or,
   * once decoded, values offchain code cannot represent (rules above 2^53 - 1, which the owner key sets).
   * With it, that log is skipped and reported here with the reason, so a reader that must keep moving (the
   * console's scanner, the executor's watch) can say so instead of stopping. Without it, decoding throws.
   */
  onUndecodable?: (log: Log, error: Error) => void;
}

export interface DecodeOptions extends ParseOptions {
  /**
   * Unix seconds per block number, for logs whose RPC did not include `blockTimestamp`.
   * `PolicyClient.getEvents` fills this in automatically.
   */
  blockTimestamps?: ReadonlyMap<bigint, number>;
}

export class EventDecodeError extends Error {
  override name = "EventDecodeError";
}

/** A Policy log as viem parses it: the event's name and its arguments, as the contract emitted them. */
export type ParsedPolicyLog = ParseEventLogsReturnType<PolicyAbi, undefined, true>[number];

/**
 * The Policy events among `logs`, as viem parses them, in order: the layer under `decodePolicyLogs`, for
 * readers that need no timestamps, such as a transaction's receipt. With `address`, a log of the contract
 * that cannot be read goes to `onUndecodable`, or throws an `EventDecodeError` that says why.
 */
export function parsePolicyLogs(logs: readonly Log[], options: ParseOptions = {}): ParsedPolicyLog[] {
  const { address, onUndecodable } = options;
  if (address === undefined)
    return parseEventLogs({ abi: policyAbi, logs: [...logs], strict: true as const });
  const parsed: ParsedPolicyLog[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, address)) continue;
    // One at a time, so a log the contract emitted but this ABI cannot read is known, not just missing.
    const [read] = parseEventLogs({ abi: policyAbi, logs: [log], strict: true as const });
    if (read !== undefined) {
      parsed.push(read);
      continue;
    }
    const error = new EventDecodeError(`${logPlace(log)} cannot be read: ${unreadableReason(log)}`);
    if (onUndecodable === undefined) throw error;
    onUndecodable(log, error);
  }
  return parsed;
}

/** "Log 3 in block 1,204 (transaction 0xabcd...)". */
export function logPlace(log: Pick<Log, "logIndex" | "blockNumber" | "transactionHash">): string {
  const block =
    log.blockNumber === null ? "a pending block" : `block ${log.blockNumber.toLocaleString("en-US")}`;
  const tx = log.transactionHash === null ? "" : ` (transaction ${log.transactionHash})`;
  return `Log ${String(log.logIndex ?? "?")} in ${block}${tx}`;
}

/** Why viem could not read a log as a Policy event, in words. */
function unreadableReason(log: Log): string {
  try {
    decodeEventLog({ abi: policyAbi, data: log.data, topics: log.topics, strict: true });
  } catch (error) {
    if (error instanceof AbiEventSignatureEmptyTopicsError) return "it has no event topic.";
    if (error instanceof AbiEventSignatureNotFoundError) {
      return `its event (topic ${String(log.topics[0])}) is not one this code knows, so the contract may not be the expected Policy.`;
    }
    if (error instanceof DecodeLogDataMismatch || error instanceof DecodeLogTopicsMismatch) {
      return `its data does not match the ${error.abiItem.name} event this code knows, so the contract may not be the expected Policy.`;
    }
    return error instanceof Error ? error.message : String(error);
  }
  return "it decodes alone but not in a batch."; // never expected: kept so a surprise is still reported
}

/**
 * Decodes viem logs (already formatted, as returned by `getLogs` or a receipt) into typed Policy events.
 * See `ParseOptions` for which logs are skipped and which are reported. Raw RPC logs must be formatted with
 * viem's `formatLog` first. A log without a block timestamp always throws: skipping it would lose it.
 */
export function decodePolicyLogs(logs: readonly Log[], options: DecodeOptions = {}): PolicyEvent[] {
  const { blockTimestamps, onUndecodable } = options;
  const parsed = parsePolicyLogs(logs, options);

  return parsed.flatMap((log): PolicyEvent[] => {
    try {
      return [decodeOne(log)];
    } catch (error) {
      if (onUndecodable === undefined || !(error instanceof UnitError)) throw error;
      onUndecodable(log, error);
      return [];
    }
  });

  function decodeOne(log: ParsedPolicyLog): PolicyEvent {
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

    // Amounts, prices and results are written by the agent and executor keys, so they may not fit a
    // number. They decode to null with the exact value in `outOfRange`; the event is always kept.
    const outOfRange: Record<string, string> = {};
    const flagged = () => (Object.keys(outOfRange).length > 0 ? { outOfRange } : {});

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
          amountCents: chainNumber(log.args.amountCents, "amountCents", outOfRange),
          limitPrice: chainNumber(log.args.limitPrice, "limitPrice", outOfRange),
          contextHash: log.args.contextHash,
          ...flagged(),
        };
      case "IntentApproved":
        return {
          ...meta,
          type: "IntentApproved",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          market: log.args.market,
          outcome: log.args.outcome,
          isBuy: log.args.isBuy,
          amountCents: chainNumber(log.args.amountCents, "amountCents", outOfRange),
          limitPrice: chainNumber(log.args.limitPrice, "limitPrice", outOfRange),
          ...flagged(),
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
          amountCents: chainNumber(log.args.amountCents, "amountCents", outOfRange),
          ...flagged(),
        };
      case "ResultRecorded":
        return {
          ...meta,
          type: "ResultRecorded",
          intentId: toSafeNumber(log.args.intentId, "intentId"),
          filled: log.args.filled,
          filledCents: chainNumber(log.args.filledCents, "filledCents", outOfRange),
          pnlCents: chainNumber(log.args.pnlCents, "pnlCents", outOfRange),
          ...flagged(),
        };
      case "PolicyUpdated":
        return { ...meta, type: "PolicyUpdated", rules: rulesFromChain(log.args) };
      case "Paused":
        return { ...meta, type: "Paused", paused: log.args.paused };
      case "UserChanged":
      case "AgentChanged":
      case "ExecutorChanged":
        return { ...meta, type: log.eventName, previous: log.args.previous, current: log.args.current };
    }
  }
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
