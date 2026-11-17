import {
  BaseError,
  ContractFunctionRevertedError,
  RpcRequestError,
  decodeFunctionData,
  encodeFunctionData,
  getContractError,
  keccak256,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { policyAbi } from "./abi";
import { raceAbort } from "./abort";
import { evaluateIntent, headroom, type Headroom, type PolicyState, type RuleInput } from "./evaluate";
import { decodePolicyLogs, rulesFromTuple, rulesToChain } from "./events";
import { ARC_MIN_MAX_FEE_PER_GAS, applyFeeFloor } from "./fees";
import { intentStatusFromCode, verdictFromCode } from "./reasons";
import {
  policyRulesSchema,
  tradeIntentSchema,
  ZERO_HASH,
  type Intent,
  type PolicyEvent,
  type PolicyRules,
  type TradeIntentInput,
} from "./types";
import { chainNumber, toSafeNumber } from "./units";

/** A verdict as the chain reports it. Reasons are strings because a contract may add new ones. */
export type ChainVerdict =
  { verdict: "approved" } | { verdict: "needs_approval" } | { verdict: "rejected"; reason: string };

export interface TxResult {
  txHash: Hex;
  blockNumber: number;
}

export type ProposeResult = ChainVerdict &
  TxResult & {
    intentId: number;
    /** False when a non-zero context hash could not be recorded because the contract lacks the overload. */
    contextHashRecorded: boolean;
  };

/** Outcome of `approveIntent`: approved, or rejected with the reason of the rule it no longer passes (any rule on the production contract, only "over budget" on the reference contract). */
export type ApproveResult = Extract<ChainVerdict, { verdict: "approved" | "rejected" }> &
  TxResult & { intentId: number };

/** `previewTrade` result, saying whether the contract answered or the TypeScript mirror did. */
export type PreviewResult = ChainVerdict & { source: "contract" | "offchain" };

export interface PolicySnapshot extends PolicyState {
  blockNumber: number;
  /** Unix seconds of the block all values were read at. */
  blockTimestamp: number;
  rules: PolicyRules;
}

export interface Roles {
  user: Address;
  agent: Address;
  executor: Address;
}

export interface RecordResultInput {
  intentId: number;
  filled: boolean;
  filledCents: number;
  pnlCents: number;
}

/**
 * Optional contract features requested in `docs/contract-interface.md`. `IntentProposed` needs no flag:
 * the reducer uses it whenever the log contains it.
 */
export interface Capabilities {
  /** `previewTrade(uint8,bool,uint256)`. Without it, previews use the TypeScript evaluator. */
  previewTrade: boolean;
  /** `proposeTrade(..., bytes32 contextHash)`. Without it, the context hash is not recorded onchain. */
  proposeWithContext: boolean;
}

export interface PolicyClientOptions {
  address: Address;
  publicClient: PublicClient<Transport, Chain>;
  /** Needed only for writes. Its account decides which role methods will succeed. */
  walletClient?: WalletClient<Transport, Chain, Account>;
  /**
   * Skip detection for these features. Anything not given is detected once, on first use, by probing the
   * contract with read-only calls.
   */
  capabilities?: Partial<Capabilities>;
  /** Lowest `maxFeePerGas` any write uses. Defaults to 20 gwei, the Arc testnet minimum. */
  minMaxFeePerGas?: bigint;
  /** How long to wait for a receipt before giving up, in milliseconds. Defaults to 60 seconds. */
  receiptTimeoutMs?: number;
  /** Longest delay between receipt checks (they back off from 10 ms), in milliseconds. Defaults to 1000. */
  receiptPollingMs?: number;
  /** Largest block range per `eth_getLogs` call. Defaults to 10,000. */
  maxLogBlockRange?: bigint;
  /**
   * Where this client's writes wait their turn. Clients that write with one key to several contracts
   * (the executor, #95) share one lane, so their writes go one at a time and never race for a nonce.
   * Defaults to a lane of this client's own.
   */
  lane?: WriteLane;
}

/** Writes that run one at a time, in the order they were asked for, whatever client asked. */
export class WriteLane {
  #tail: Promise<unknown> = Promise.resolve();

  /** Runs `task` after every task already in the lane has settled. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export class PolicyClientError extends Error {
  override name = "PolicyClientError";
}

/**
 * Options for one write. A write has two parts: everything before the broadcast (waiting for earlier
 * writes from this client, fees, the simulation, signing), which `signal` can stop with nothing sent,
 * and the broadcast with the wait for its receipt, which `signal` never cuts short: once a
 * transaction may have reached the node, the write only ends with its receipt or with "no receipt"
 * (`PolicyClientError`, "no receipt for <hash>"), never with an error that looks safe to retry.
 */
export interface WriteOptions {
  /** Stops the write while it has not been broadcast; the write then rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
  /**
   * Called right before the broadcast. It may throw, and then nothing is sent. It may return a bound
   * for the rest of the write: when that signal aborts, the write stops waiting for the receipt and
   * rejects with "no receipt" (the transaction may still land).
   */
  beforeBroadcast?: (() => AbortSignal | undefined) | undefined;
}

/** A write the contract refused, with its custom error name when the ABI knows it (for example "NotUser"). */
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

/** An address that is never the agent, used to probe for the `proposeTrade` overload without side effects. */
const PROBE_SENDER: Address = "0x000000000000000000000000000000000000dEaD";

/**
 * Typed access to the Policy contract, working against the production contract and against the
 * reference contract with extensions. One method per role action:
 * - anyone: reads, `previewTrade`, `getEvents`, `watchEvents`
 * - agent: `proposeTrade`
 * - user: `setPolicy`, `setPaused`, `approveIntent`, `rejectIntent`, `setUser` (v2 only), `setAgent`, `setExecutor`
 * - executor: `recordResult`
 *
 * Every write is simulated first (so a revert surfaces with the contract's error name), sent with EIP-1559
 * fees no lower than `minMaxFeePerGas`, and awaited until its receipt. Writes from one client are
 * serialized (on the client's `lane`) so concurrent calls never race for the same nonce.
 */
export class PolicyClient {
  readonly address: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account> | undefined;
  private readonly minMaxFeePerGas: bigint;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollingMs: number;
  private readonly maxLogBlockRange: bigint;
  private readonly capabilityOverrides: Partial<Capabilities>;
  private capabilitiesPromise: Promise<Capabilities> | undefined;
  private readonly lane: WriteLane;

  constructor(options: PolicyClientOptions) {
    this.address = options.address;
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
    this.capabilityOverrides = options.capabilities ?? {};
    this.lane = options.lane ?? new WriteLane();
    this.minMaxFeePerGas = options.minMaxFeePerGas ?? ARC_MIN_MAX_FEE_PER_GAS;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 60_000;
    this.receiptPollingMs = options.receiptPollingMs ?? 1_000;
    this.maxLogBlockRange = options.maxLogBlockRange ?? 10_000n;
    if (this.maxLogBlockRange < 1n) throw new PolicyClientError("maxLogBlockRange must be at least 1");
  }

  /** The account writes are sent from, or undefined for a read-only client. */
  get account(): Account | undefined {
    return this.walletClient?.account;
  }

  // ---------------------------------------------------------------- capabilities

  /** Which requested extensions this contract has. Detected once with read-only calls, then cached. */
  getCapabilities(): Promise<Capabilities> {
    this.capabilitiesPromise ??= this.detectCapabilities();
    return this.capabilitiesPromise;
  }

  private async detectCapabilities(): Promise<Capabilities> {
    const { previewTrade, proposeWithContext } = this.capabilityOverrides;
    const [hasPreview, hasContext] = await Promise.all([
      previewTrade ?? this.probePreviewTrade(),
      proposeWithContext ?? this.probeProposeWithContext(),
    ]);
    return { previewTrade: hasPreview, proposeWithContext: hasContext };
  }

  private async probePreviewTrade(): Promise<boolean> {
    try {
      await this.publicClient.readContract({
        address: this.address,
        abi: policyAbi,
        functionName: "previewTrade",
        args: [0, true, 1n],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** The overload exists if a call from a non-agent reverts with `NotAgent` rather than empty data. */
  private async probeProposeWithContext(): Promise<boolean> {
    const args = ["probe", 0, "YES", true, 1n, 1n, ZERO_HASH] as const;
    const data = encodeFunctionData({ abi: policyAbi, functionName: "proposeTrade", args });
    try {
      await this.publicClient.call({ account: PROBE_SENDER, to: this.address, data });
      return true;
    } catch (error) {
      if (!(error instanceof BaseError)) return false;
      const decoded = getContractError(error, {
        abi: policyAbi,
        address: this.address,
        args,
        functionName: "proposeTrade",
      });
      return revertErrorName(decoded) === "NotAgent";
    }
  }

  // ---------------------------------------------------------------- reads

  async getRules(): Promise<PolicyRules> {
    return rulesFromTuple(
      await this.publicClient.readContract({ address: this.address, abi: policyAbi, functionName: "policy" }),
    );
  }

  async getRoles(): Promise<Roles> {
    const read = (functionName: "user" | "agent" | "executor") =>
      this.publicClient.readContract({ address: this.address, abi: policyAbi, functionName });
    const [user, agent, executor] = await Promise.all([read("user"), read("agent"), read("executor")]);
    return { user, agent, executor };
  }

  /** Rules, committed spend and today's loss, all read at the same block. */
  async getSnapshot(): Promise<PolicySnapshot> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const at = { address: this.address, abi: policyAbi, blockNumber: block.number } as const;
    const [rules, committed, loss] = await Promise.all([
      this.publicClient.readContract({ ...at, functionName: "policy" }),
      this.publicClient.readContract({ ...at, functionName: "committedCents" }),
      this.publicClient.readContract({ ...at, functionName: "lossTodayCents" }),
    ]);
    return {
      blockNumber: toSafeNumber(block.number, "blockNumber"),
      blockTimestamp: toSafeNumber(block.timestamp, "blockTimestamp"),
      rules: rulesFromTuple(rules),
      committedCents: toSafeNumber(committed, "committedCents"),
      lossTodayCents: toSafeNumber(loss, "lossTodayCents"),
    };
  }

  async getHeadroom(): Promise<Headroom> {
    const snapshot = await this.getSnapshot();
    return headroom(snapshot.rules, snapshot);
  }

  async getIntentCount(): Promise<number> {
    const count = await this.publicClient.readContract({
      address: this.address,
      abi: policyAbi,
      functionName: "intentCount",
    });
    return toSafeNumber(count, "intentCount");
  }

  /** The stored intent, or null when no intent has this id (ids start at 0). */
  async getIntent(intentId: number): Promise<Intent | null> {
    if (!Number.isSafeInteger(intentId) || intentId < 0) return null;
    if (intentId >= (await this.getIntentCount())) return null;
    const raw = await this.publicClient.readContract({
      address: this.address,
      abi: policyAbi,
      functionName: "getIntent",
      args: [BigInt(intentId)],
    });
    // Whatever the agent and executor keys wrote: out-of-range numbers come back null and flagged.
    const outOfRange: Record<string, string> = {};
    const intent: Intent = {
      id: intentId,
      market: raw.market,
      category: raw.category,
      outcome: raw.outcome,
      isBuy: raw.isBuy,
      amountCents: chainNumber(raw.amountCents, "amountCents", outOfRange),
      limitPrice: chainNumber(raw.limitPrice, "limitPrice", outOfRange),
      status: intentStatusFromCode(raw.status),
      proposedAt: toSafeNumber(raw.proposedAt, "proposedAt"),
      filledCents: chainNumber(raw.filledCents, "filledCents", outOfRange),
      pnlCents: chainNumber(raw.pnlCents, "pnlCents", outOfRange),
    };
    return Object.keys(outOfRange).length > 0 ? { ...intent, outOfRange } : intent;
  }

  /** Stored intents in id order (all of them, or the given ids). */
  async getIntents(ids?: readonly number[]): Promise<Intent[]> {
    const wanted = ids ?? Array.from({ length: await this.getIntentCount() }, (_, i) => i);
    const intents = await Promise.all(wanted.map((id) => this.getIntent(id)));
    return intents.filter((intent): intent is Intent => intent !== null);
  }

  /**
   * What `proposeTrade` would decide right now. Uses the contract's `previewTrade` when it has one,
   * otherwise runs the TypeScript mirror of the rules on a fresh snapshot.
   */
  async previewTrade(input: RuleInput): Promise<PreviewResult> {
    const { previewTrade } = await this.getCapabilities();
    if (!previewTrade) {
      const snapshot = await this.getSnapshot();
      return { ...evaluateIntent(snapshot.rules, snapshot, input), source: "offchain" };
    }
    const [code, reason] = await this.publicClient.readContract({
      address: this.address,
      abi: policyAbi,
      functionName: "previewTrade",
      args: [input.category, input.isBuy, BigInt(input.amountCents)],
    });
    const verdict = verdictFromCode(code);
    return verdict === "rejected" ? { verdict, reason, source: "contract" } : { verdict, source: "contract" };
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
          const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
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

  /**
   * Proposes an intent and returns the contract's verdict. A rejection is a result, not an error.
   * The context hash is recorded only when the contract has the `proposeTrade` overload for it.
   */
  async proposeTrade(input: TradeIntentInput, options: WriteOptions = {}): Promise<ProposeResult> {
    const intent = tradeIntentSchema.parse(input);
    const { proposeWithContext } = await this.getCapabilities();
    options.signal?.throwIfAborted();
    const base = [
      intent.market,
      intent.category,
      intent.outcome,
      intent.isBuy,
      BigInt(intent.amountCents),
      BigInt(intent.limitPrice),
    ] as const;
    const data = proposeWithContext
      ? encodeFunctionData({
          abi: policyAbi,
          functionName: "proposeTrade",
          args: [...base, intent.contextHash],
        })
      : encodeFunctionData({ abi: policyAbi, functionName: "proposeTrade", args: base });
    const receipt = await this.send(data, options);
    const intentId = this.verdictIntentId(receipt);
    return {
      ...this.verdictFor(receipt, intentId),
      intentId,
      contextHashRecorded: proposeWithContext || intent.contextHash === ZERO_HASH,
      ...txResult(receipt),
    };
  }

  // ---------------------------------------------------------------- user

  async setPolicy(rules: PolicyRules): Promise<TxResult> {
    const p = rulesToChain(policyRulesSchema.parse(rules));
    return txResult(
      await this.send(encodeFunctionData({ abi: policyAbi, functionName: "setPolicy", args: [p] })),
    );
  }

  async setPaused(paused: boolean): Promise<TxResult> {
    return txResult(
      await this.send(encodeFunctionData({ abi: policyAbi, functionName: "setPaused", args: [paused] })),
    );
  }

  /** Hands the user role to another address. Only the production contract (v2) has it. */
  async setUser(user: Address): Promise<TxResult> {
    return txResult(
      await this.send(encodeFunctionData({ abi: policyAbi, functionName: "setUser", args: [user] })),
    );
  }

  async setAgent(agent: Address): Promise<TxResult> {
    return txResult(
      await this.send(encodeFunctionData({ abi: policyAbi, functionName: "setAgent", args: [agent] })),
    );
  }

  async setExecutor(executor: Address): Promise<TxResult> {
    return txResult(
      await this.send(encodeFunctionData({ abi: policyAbi, functionName: "setExecutor", args: [executor] })),
    );
  }

  async approveIntent(intentId: number): Promise<ApproveResult> {
    const receipt = await this.send(
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
        encodeFunctionData({ abi: policyAbi, functionName: "rejectIntent", args: [BigInt(intentId)] }),
      ),
    );
  }

  // ---------------------------------------------------------------- executor

  async recordResult(result: RecordResultInput): Promise<TxResult> {
    return txResult(
      await this.send(
        encodeFunctionData({
          abi: policyAbi,
          functionName: "recordResult",
          args: [BigInt(result.intentId), result.filled, BigInt(result.filledCents), BigInt(result.pnlCents)],
        }),
      ),
    );
  }

  // ---------------------------------------------------------------- internals

  /** Current EIP-1559 fees with the configured floor applied. */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const estimate = await this.publicClient.estimateFeesPerGas({ type: "eip1559" });
    return applyFeeFloor(estimate, this.minMaxFeePerGas);
  }

  /**
   * Simulates, sends and awaits one write. The call data is encoded by the caller with
   * `encodeFunctionData`, which keeps every call site fully typed against the ABI. See `WriteOptions`
   * for what `signal` can stop.
   */
  private send(data: Hex, options: WriteOptions = {}): Promise<TransactionReceipt> {
    const { functionName, args } = decodeFunctionData({ abi: policyAbi, data });
    const { signal, beforeBroadcast } = options;
    let started = false;
    let cancelled = false;
    const run = async (): Promise<TransactionReceipt> => {
      // Given up while waiting for an earlier write: this one is never started.
      if (cancelled) throw new PolicyClientError(`${functionName} was cancelled before it started`);
      started = true;
      signal?.throwIfAborted();
      const wallet = this.walletClient;
      if (!wallet) throw new PolicyClientError(`${functionName} needs a wallet client`);
      const account = wallet.account;
      const fees = await this.fees();
      signal?.throwIfAborted();
      try {
        await this.publicClient.call({ account, to: this.address, data, ...fees });
      } catch (error) {
        if (!(error instanceof BaseError)) throw error;
        const decoded = getContractError(error, {
          abi: policyAbi,
          address: this.address,
          args,
          functionName,
          sender: account.address,
        });
        throw new PolicyRevertError(functionName, revertErrorName(decoded), decoded);
      }
      const { hash, bound } = await this.broadcast(wallet, data, fees, { signal, beforeBroadcast });
      const receipt = await this.waitForReceipt(hash, bound);
      if (receipt.status !== "success") {
        throw new PolicyClientError(`${functionName} transaction ${hash} reverted`);
      }
      return receipt;
    };
    const result = this.lane.run(run);
    if (signal === undefined) return result;
    return new Promise<TransactionReceipt>((resolve, reject) => {
      const onAbort = () => {
        if (started) return;
        cancelled = true;
        reject(signal.reason as Error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      void result.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  /**
   * Signs the transaction and sends it, returning its hash. With a local account the hash is known
   * before anything is sent, so a broadcast that fails without the node refusing it (a timeout, a
   * dropped connection) is still followed to its receipt: it may have reached the node.
   */
  private async broadcast(
    wallet: WalletClient<Transport, Chain, Account>,
    data: Hex,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    options: WriteOptions,
  ): Promise<{ hash: Hex; bound: AbortSignal | undefined }> {
    const account = wallet.account;
    if (account.type !== "local") {
      options.signal?.throwIfAborted();
      const bound = options.beforeBroadcast?.();
      const hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: this.address,
        data,
        ...fees,
      });
      return { hash, bound };
    }
    const request = await wallet.prepareTransactionRequest({
      account,
      chain: wallet.chain,
      to: this.address,
      data,
      ...fees,
    });
    const serializedTransaction = await wallet.signTransaction(request);
    const hash = keccak256(serializedTransaction);
    options.signal?.throwIfAborted();
    const bound = options.beforeBroadcast?.();
    try {
      await wallet.sendRawTransaction({ serializedTransaction });
    } catch (error) {
      if (!mayHaveReachedNode(error)) throw error;
    }
    return { hash, bound };
  }

  /**
   * Polls `eth_getTransactionReceipt` directly. viem's `waitForTransactionReceipt` compares against a
   * cached block number, which adds a full polling interval per write on a fast chain such as anvil.
   * A failed poll is polled again: the transaction is out, so only its receipt, the timeout or the
   * write's `bound` ends the wait.
   */
  private async waitForReceipt(hash: Hex, bound?: AbortSignal): Promise<TransactionReceipt> {
    const deadline = Date.now() + this.receiptTimeoutMs;
    // Back off from 10 ms: anvil mines within milliseconds, Arc within about a second.
    let delay = 10;
    for (;;) {
      try {
        return await raceAbort(this.publicClient.getTransactionReceipt({ hash }), bound);
      } catch (error) {
        if (!(error instanceof BaseError) && bound?.aborted !== true) throw error;
      }
      if (bound?.aborted === true) {
        throw new PolicyClientError(
          `no receipt for ${hash} within the time this write had; it may still land`,
        );
      }
      if (Date.now() > deadline) {
        throw new PolicyClientError(
          `no receipt for ${hash} after ${this.receiptTimeoutMs} ms; on Arc this usually means the fee was too low`,
        );
      }
      await raceAbort(sleep(delay), bound).catch(() => undefined);
      delay = Math.min(delay * 2, this.receiptPollingMs);
    }
  }

  private receiptEvents(receipt: TransactionReceipt) {
    return parseEventLogs({
      abi: policyAbi,
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.address.toLowerCase()),
      strict: true,
    });
  }

  /** The id of the intent a proposal created, from its verdict event (present on every contract). */
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

/** The contract error name inside an error (for example "NotUser"), or null when there is none. */
export function revertErrorName(error: unknown): string | null {
  if (error instanceof PolicyRevertError) return error.errorName;
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? null;
  return null;
}

/**
 * Whether a failed broadcast may still have reached the node. Only an answer from the node that
 * refuses the transaction means it was not taken; "already known" or "nonce too low" can be the node
 * telling a retry that it already has this very transaction.
 */
function mayHaveReachedNode(error: unknown): boolean {
  if (!(error instanceof BaseError)) return true;
  const answer = error.walk((e) => e instanceof RpcRequestError);
  if (answer === null) return true;
  return /already known|known transaction|already imported|nonce too low/i.test(
    answer instanceof BaseError ? answer.details : "",
  );
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
