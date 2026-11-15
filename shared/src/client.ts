import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getContractError,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { policyAbi, type PolicyAbi } from "./abi";
import { headroom, type Headroom, type PolicyState, type RuleInput } from "./evaluate";
import { decodePolicyLogs, policyFromChain, policyToChain } from "./events";
import { ARC_MIN_MAX_FEE_PER_GAS, applyFeeFloor } from "./fees";
import { intentStatusFromCode, verdictFromCode, type Verdict } from "./reasons";
import {
  policySchema,
  tradeIntentSchema,
  type Intent,
  type Policy,
  type PolicyEvent,
  type TradeIntentInput,
} from "./types";
import { toSafeNumber } from "./units";

/** A verdict as the chain reports it. Reasons are strings because a contract may add codes. */
export type ChainVerdict =
  { verdict: "approved" } | { verdict: "needs_approval" } | { verdict: "rejected"; reason: string };

export interface TxResult {
  txHash: Hex;
  blockNumber: number;
}

export type ProposeResult = ChainVerdict & TxResult & { intentId: number };

/** Outcome of `approveIntent`: approved, or rejected with OVER_BUDGET when the intent no longer fits. */
export type ApproveResult = Extract<ChainVerdict, { verdict: "approved" | "rejected" }> &
  TxResult & { intentId: number };

export interface PolicySnapshot extends PolicyState {
  blockNumber: number;
  /** Unix seconds of the block all values were read at. */
  blockTimestamp: number;
  policy: Policy;
}

export interface Roles {
  owner: Address;
  agent: Address;
  executor: Address;
}

export interface RecordResultInput {
  intentId: number;
  filled: boolean;
  filledCents: number;
  pnlCents: number;
}

export interface PolicyClientOptions {
  address: Address;
  publicClient: PublicClient<Transport, Chain>;
  /** Needed only for writes. Its account decides which role methods will succeed. */
  walletClient?: WalletClient<Transport, Chain, Account>;
  /** Lowest `maxFeePerGas` any write uses. Defaults to 20 gwei, the Arc testnet minimum. */
  minMaxFeePerGas?: bigint;
  /** How long to wait for a receipt before giving up, in milliseconds. Defaults to 60 seconds. */
  receiptTimeoutMs?: number;
  /** Largest block range per `eth_getLogs` call. Defaults to 10,000. */
  maxLogBlockRange?: bigint;
}

export class PolicyClientError extends Error {
  override name = "PolicyClientError";
}

/** A write the contract refused, with its custom error name when the ABI knows it (for example "NotOwner"). */
export class PolicyRevertError extends PolicyClientError {
  override name = "PolicyRevertError";
  constructor(
    readonly functionName: string,
    readonly errorName: string | null,
    cause: unknown,
  ) {
    const detail = cause instanceof BaseError ? cause.shortMessage : String(cause);
    super(`${functionName} reverted${errorName ? ` with ${errorName}` : ""}: ${detail}`, { cause });
  }
}

type WriteFunctionName = ContractFunctionName<PolicyAbi, "nonpayable">;

/**
 * Typed access to the Policy contract with one method per role action:
 * - anyone: reads, `previewTrade`, `getEvents`, `watchEvents`
 * - agent: `proposeTrade`
 * - owner: `setPolicy`, `approveIntent`, `rejectIntent`, `setPaused`, `setAgent`, `setExecutor`
 * - executor: `recordResult`
 *
 * Every write is simulated first (so a revert surfaces with the contract's error name), sent with EIP-1559
 * fees no lower than `minMaxFeePerGas`, and awaited until its receipt. Writes from one client are
 * serialized so concurrent calls never race for the same nonce.
 */
export class PolicyClient {
  readonly address: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account> | undefined;
  private readonly minMaxFeePerGas: bigint;
  private readonly receiptTimeoutMs: number;
  private readonly maxLogBlockRange: bigint;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: PolicyClientOptions) {
    this.address = options.address;
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
    this.minMaxFeePerGas = options.minMaxFeePerGas ?? ARC_MIN_MAX_FEE_PER_GAS;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 60_000;
    this.maxLogBlockRange = options.maxLogBlockRange ?? 10_000n;
    if (this.maxLogBlockRange < 1n) throw new PolicyClientError("maxLogBlockRange must be at least 1");
  }

  /** The account writes are sent from, or undefined for a read-only client. */
  get account(): Account | undefined {
    return this.walletClient?.account;
  }

  // ---------------------------------------------------------------- reads

  async getPolicy(): Promise<Policy> {
    return policyFromChain(await this.read("policy"));
  }

  async getRoles(): Promise<Roles> {
    const [owner, agent, executor] = await Promise.all([
      this.read("owner"),
      this.read("agent"),
      this.read("executor"),
    ]);
    return { owner, agent, executor };
  }

  /** Policy, spend and today's loss, all read at the same block. */
  async getSnapshot(): Promise<PolicySnapshot> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const blockNumber = block.number;
    const at = { blockNumber };
    const [policy, spent, loss] = await Promise.all([
      this.publicClient.readContract({
        address: this.address,
        abi: policyAbi,
        functionName: "policy",
        ...at,
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: policyAbi,
        functionName: "spentCents",
        ...at,
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: policyAbi,
        functionName: "lossTodayCents",
        ...at,
      }),
    ]);
    return {
      blockNumber: toSafeNumber(blockNumber, "blockNumber"),
      blockTimestamp: toSafeNumber(block.timestamp, "blockTimestamp"),
      policy: policyFromChain(policy),
      spentCents: toSafeNumber(spent, "spentCents"),
      lossTodayCents: toSafeNumber(loss, "lossTodayCents"),
    };
  }

  async getHeadroom(): Promise<Headroom> {
    const snapshot = await this.getSnapshot();
    return headroom(snapshot.policy, snapshot);
  }

  async getIntentCount(): Promise<number> {
    return toSafeNumber(await this.read("intentCount"), "intentCount");
  }

  /** The stored intent, or null when no intent has this id. */
  async getIntent(intentId: number): Promise<Intent | null> {
    const raw = await this.publicClient.readContract({
      address: this.address,
      abi: policyAbi,
      functionName: "getIntent",
      args: [BigInt(intentId)],
    });
    if (raw.status === 0 && raw.proposedAt === 0n) return null;
    const filledOrUnfilled = raw.status === 4 || raw.status === 5;
    return {
      id: intentId,
      agent: raw.agent,
      market: raw.market,
      category: raw.category,
      outcome: raw.outcome,
      isBuy: raw.isBuy,
      amountCents: toSafeNumber(raw.amountCents, "amountCents"),
      limitPrice: toSafeNumber(raw.limitPrice, "limitPrice"),
      contextHash: raw.contextHash,
      status: intentStatusFromCode(raw.status),
      reason: raw.reason === "" ? null : raw.reason,
      proposedAt: toSafeNumber(raw.proposedAt, "proposedAt"),
      filledCents: filledOrUnfilled ? toSafeNumber(raw.filledCents, "filledCents") : null,
      pnlCents: filledOrUnfilled ? toSafeNumber(raw.pnlCents, "pnlCents") : null,
    };
  }

  /** Every stored intent in id order. Prefer `getEvents` plus `reduceEvents` for large histories. */
  async getIntents(): Promise<Intent[]> {
    const count = await this.getIntentCount();
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const intents = await Promise.all(ids.map((id) => this.getIntent(id)));
    return intents.filter((intent): intent is Intent => intent !== null);
  }

  /** Dry run against current chain state, using the contract's own rule function. */
  async previewTrade(input: RuleInput): Promise<ChainVerdict> {
    const [code, reason] = await this.publicClient.readContract({
      address: this.address,
      abi: policyAbi,
      functionName: "previewTrade",
      args: [input.category, input.isBuy, BigInt(input.amountCents)],
    });
    return toChainVerdict(verdictFromCode(code), reason);
  }

  /** Decoded Policy events in `[fromBlock, toBlock]`, split into ranges the RPC accepts. */
  async getEvents(range: { fromBlock: bigint; toBlock?: bigint }): Promise<PolicyEvent[]> {
    const toBlock = range.toBlock ?? (await this.publicClient.getBlockNumber());
    const logs: Log[] = [];
    for (let start = range.fromBlock; start <= toBlock; start += this.maxLogBlockRange) {
      const end = start + this.maxLogBlockRange - 1n < toBlock ? start + this.maxLogBlockRange - 1n : toBlock;
      logs.push(
        ...(await this.publicClient.getLogs({ address: this.address, fromBlock: start, toBlock: end })),
      );
    }
    return decodePolicyLogs(logs, {
      address: this.address,
      blockTimestamps: await this.blockTimestamps(logs),
    });
  }

  /**
   * Polls for new events and calls `onEvents` with each non-empty batch, in chain order. Starts at
   * `fromBlock` (default: the next block). Returns a function that stops watching.
   */
  watchEvents(options: {
    onEvents: (events: PolicyEvent[]) => void | Promise<void>;
    onError?: (error: unknown) => void;
    fromBlock?: bigint;
    pollingIntervalMs?: number;
  }): () => void {
    const interval = options.pollingIntervalMs ?? 1_000;
    let stopped = false;
    // Read through a function so the compiler does not narrow `stopped` across awaits.
    const isStopped = (): boolean => stopped;
    let next = options.fromBlock;
    const loop = async (): Promise<void> => {
      while (!isStopped()) {
        try {
          const latest = await this.publicClient.getBlockNumber();
          next ??= latest + 1n;
          if (latest >= next) {
            const events = await this.getEvents({ fromBlock: next, toBlock: latest });
            next = latest + 1n;
            if (events.length > 0 && !isStopped()) await options.onEvents(events);
          }
        } catch (error) {
          (options.onError ?? defaultWatchError)(error);
        }
        await sleep(interval);
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  // ---------------------------------------------------------------- agent

  /** Proposes an intent and returns the contract's verdict. A rejection is a result, not an error. */
  async proposeTrade(input: TradeIntentInput): Promise<ProposeResult> {
    const intent = tradeIntentSchema.parse(input);
    const receipt = await this.send(
      "proposeTrade",
      encodeFunctionData({
        abi: policyAbi,
        functionName: "proposeTrade",
        args: [
          intent.market,
          intent.category,
          intent.outcome,
          intent.isBuy,
          BigInt(intent.amountCents),
          BigInt(intent.limitPrice),
          intent.contextHash,
        ],
      }),
    );
    const proposed = this.receiptEvents(receipt).find((log) => log.eventName === "IntentProposed");
    const intentId = proposed
      ? toSafeNumber(proposed.args.intentId, "intentId")
      : this.verdictIntentId(receipt);
    return { ...this.verdictFor(receipt, intentId), intentId, ...txResult(receipt) };
  }

  // ---------------------------------------------------------------- owner

  async setPolicy(policy: Policy): Promise<TxResult> {
    return txResult(
      await this.send(
        "setPolicy",
        encodeFunctionData({
          abi: policyAbi,
          functionName: "setPolicy",
          args: [policyToChain(policySchema.parse(policy))],
        }),
      ),
    );
  }

  async approveIntent(intentId: number): Promise<ApproveResult> {
    const receipt = await this.send(
      "approveIntent",
      encodeFunctionData({ abi: policyAbi, functionName: "approveIntent", args: [BigInt(intentId)] }),
    );
    const verdict = this.verdictFor(receipt, intentId);
    if (verdict.verdict === "needs_approval") {
      throw new PolicyClientError(`intent ${intentId} still needs approval after approveIntent`);
    }
    return { ...verdict, intentId, ...txResult(receipt) };
  }

  async rejectIntent(intentId: number): Promise<TxResult> {
    return txResult(
      await this.send(
        "rejectIntent",
        encodeFunctionData({ abi: policyAbi, functionName: "rejectIntent", args: [BigInt(intentId)] }),
      ),
    );
  }

  async setPaused(paused: boolean): Promise<TxResult> {
    return txResult(
      await this.send(
        "setPaused",
        encodeFunctionData({ abi: policyAbi, functionName: "setPaused", args: [paused] }),
      ),
    );
  }

  async setAgent(agent: Address): Promise<TxResult> {
    return txResult(
      await this.send(
        "setAgent",
        encodeFunctionData({ abi: policyAbi, functionName: "setAgent", args: [agent] }),
      ),
    );
  }

  async setExecutor(executor: Address): Promise<TxResult> {
    return txResult(
      await this.send(
        "setExecutor",
        encodeFunctionData({ abi: policyAbi, functionName: "setExecutor", args: [executor] }),
      ),
    );
  }

  // ---------------------------------------------------------------- executor

  async recordResult(result: RecordResultInput): Promise<TxResult> {
    return txResult(
      await this.send(
        "recordResult",
        encodeFunctionData({
          abi: policyAbi,
          functionName: "recordResult",
          args: [BigInt(result.intentId), result.filled, BigInt(result.filledCents), BigInt(result.pnlCents)],
        }),
      ),
    );
  }

  // ---------------------------------------------------------------- internals

  private read<
    fn extends "policy" | "owner" | "agent" | "executor" | "spentCents" | "lossTodayCents" | "intentCount",
  >(functionName: fn): Promise<ContractFunctionReturnType<PolicyAbi, "view", fn>> {
    return this.publicClient.readContract({ address: this.address, abi: policyAbi, functionName });
  }

  /** Current EIP-1559 fees with the configured floor applied. */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const estimate = await this.publicClient.estimateFeesPerGas({ type: "eip1559" });
    return applyFeeFloor(estimate, this.minMaxFeePerGas);
  }

  /**
   * Simulates, sends and awaits one write. The call data is encoded by the caller with
   * `encodeFunctionData`, which keeps every call site fully typed against the ABI.
   */
  private send(functionName: WriteFunctionName, data: Hex): Promise<TransactionReceipt> {
    const run = async (): Promise<TransactionReceipt> => {
      const wallet = this.walletClient;
      if (!wallet) throw new PolicyClientError(`${functionName} needs a wallet client`);
      const account = wallet.account;
      const fees = await this.fees();
      try {
        await this.publicClient.call({ account, to: this.address, data, ...fees });
      } catch (error) {
        if (!(error instanceof BaseError)) throw error;
        const decoded = getContractError(error, {
          abi: policyAbi,
          address: this.address,
          args: undefined,
          functionName,
          sender: account.address,
        });
        throw new PolicyRevertError(functionName, revertErrorName(decoded), decoded);
      }
      const hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: this.address,
        data,
        ...fees,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.receiptTimeoutMs,
      });
      if (receipt.status !== "success") {
        throw new PolicyClientError(`${functionName} transaction ${hash} reverted`);
      }
      return receipt;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private receiptEvents(receipt: TransactionReceipt) {
    return parseEventLogs({
      abi: policyAbi,
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.address.toLowerCase()),
      strict: true,
    });
  }

  private verdictIntentId(receipt: TransactionReceipt): number {
    for (const log of this.receiptEvents(receipt)) {
      if (
        log.eventName === "IntentApproved" ||
        log.eventName === "IntentRejected" ||
        log.eventName === "IntentNeedsApproval"
      ) {
        return toSafeNumber(log.args.intentId, "intentId");
      }
    }
    throw new PolicyClientError(`transaction ${receipt.transactionHash} emitted no verdict event`);
  }

  private verdictFor(receipt: TransactionReceipt, intentId: number): ChainVerdict {
    for (const log of this.receiptEvents(receipt)) {
      if (!("intentId" in log.args) || log.args.intentId !== BigInt(intentId)) continue;
      if (log.eventName === "IntentApproved") return { verdict: "approved" };
      if (log.eventName === "IntentNeedsApproval") return { verdict: "needs_approval" };
      if (log.eventName === "IntentRejected") return { verdict: "rejected", reason: log.args.reason };
    }
    throw new PolicyClientError(
      `transaction ${receipt.transactionHash} emitted no verdict for intent ${intentId}`,
    );
  }

  private async blockTimestamps(logs: readonly Log[]): Promise<Map<bigint, number>> {
    const missing = new Set<bigint>();
    for (const log of logs) {
      if (log.blockTimestamp == null && log.blockNumber !== null) missing.add(log.blockNumber);
    }
    const entries = await Promise.all(
      [...missing].map(async (blockNumber) => {
        const block = await this.publicClient.getBlock({ blockNumber });
        return [blockNumber, toSafeNumber(block.timestamp, "timestamp")] as const;
      }),
    );
    return new Map(entries);
  }
}

/** The contract error name inside a viem error (for example "NotOwner"), or null when there is none. */
export function revertErrorName(error: unknown): string | null {
  if (error instanceof PolicyRevertError) return error.errorName;
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? null;
  return null;
}

function toChainVerdict(verdict: Verdict, reason: string): ChainVerdict {
  return verdict === "rejected" ? { verdict, reason } : { verdict };
}

function txResult(receipt: TransactionReceipt): TxResult {
  return { txHash: receipt.transactionHash, blockNumber: toSafeNumber(receipt.blockNumber, "blockNumber") };
}

function defaultWatchError(error: unknown): void {
  console.error("[PolicyClient.watchEvents]", error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
