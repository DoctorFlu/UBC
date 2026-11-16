/**
 * The chain surface: what a stolen agent key can do without our server. Every call is a raw
 * transaction signed by the agent account and sent straight to the Policy contract.
 *
 * Each attempt is simulated first, to learn the contract's own error name, and then sent anyway with
 * a fixed gas limit, the way a hostile client would. A refused call therefore leaves a mined,
 * reverted transaction onchain, and the attempt reports its hash.
 */
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getContractError,
  http,
  parseEventLogs,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  applyFeeFloor,
  ARC_MIN_MAX_FEE_PER_GAS,
  devchain,
  policyAbi,
  revertErrorName,
} from "@mandate/shared";

/** Enough for every Policy call here, including a proposal with a 4 KiB market string. */
const FALLBACK_GAS = 6_000_000n;

export type ChainVerdict =
  | { kind: "approved"; intentId: number }
  | { kind: "needs_approval"; intentId: number }
  | { kind: "rejected"; intentId: number; reason: string };

export interface ChainAttempt {
  /** The mined transaction, or null when the node refused to accept it at all. */
  txHash: Hex | null;
  /** `success` and `reverted` are mined transactions; `refused` never made it into a block. */
  status: "success" | "reverted" | "refused";
  /** The contract's error name for a revert (for example "NotUser"), or a short description. */
  error: string | null;
  /** The proposal's verdict, read from the verdict event in the receipt. */
  verdict: ChainVerdict | null;
  /** Names of the Policy events the transaction emitted. */
  events: string[];
}

export function chainFor(rpcUrl: string, chainId?: number): Chain {
  return {
    ...devchain,
    ...(chainId === undefined ? {} : { id: chainId }),
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export function readClient(rpcUrl: string, chainId?: number): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: chainFor(rpcUrl, chainId),
    transport: http(rpcUrl),
    pollingInterval: 50,
  });
}

type PolicyWrite =
  | "proposeTrade"
  | "setPolicy"
  | "setPaused"
  | "setAgent"
  | "setExecutor"
  | "approveIntent"
  | "rejectIntent"
  | "recordResult";

/** The arguments of one Policy write, typed by the ABI. */
export interface PolicyCall {
  functionName: PolicyWrite;
  args: readonly unknown[];
}

export class ChainAttacker {
  readonly address: Address;
  readonly policy: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly #wallet: WalletClient<Transport, Chain, Account>;

  constructor(options: { rpcUrl: string; chainId?: number; policy: Address; account: Account }) {
    const chain = chainFor(options.rpcUrl, options.chainId);
    this.policy = options.policy;
    this.address = options.account.address;
    this.publicClient = readClient(options.rpcUrl, options.chainId);
    this.#wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: options.account });
  }

  /** Encodes a Policy write. Throws only for arguments the ABI cannot encode. */
  encode(call: PolicyCall): Hex {
    // Arguments are deliberately loose: attacks send values the typed ABI helpers would refuse.
    const abi: Abi = policyAbi;
    return encodeFunctionData({ abi, functionName: call.functionName, args: call.args });
  }

  /** Proposes with the base 6-argument `proposeTrade`, which every Policy contract has. */
  propose(intent: {
    market: string;
    category: number;
    outcome: string;
    isBuy: boolean;
    amountCents: bigint;
    limitPrice: bigint;
  }): Promise<ChainAttempt> {
    return this.send({
      functionName: "proposeTrade",
      args: [
        intent.market,
        intent.category,
        intent.outcome,
        intent.isBuy,
        intent.amountCents,
        intent.limitPrice,
      ],
    });
  }

  /** Simulates, then sends the call whatever the simulation said. */
  send(call: PolicyCall, options: { value?: bigint } = {}): Promise<ChainAttempt> {
    return this.sendData(this.encode(call), { ...options, functionName: call.functionName });
  }

  /** Sends raw calldata (for calls the ABI cannot express, such as an out-of-range `uint8`). */
  async sendData(
    data: Hex,
    options: { value?: bigint; functionName?: PolicyWrite } = {},
  ): Promise<ChainAttempt> {
    const value = options.value ?? 0n;
    const simulatedError = await this.simulate(data, value, options.functionName);
    const fees = applyFeeFloor(
      await this.publicClient.estimateFeesPerGas({ type: "eip1559" }),
      ARC_MIN_MAX_FEE_PER_GAS,
    );
    let gas = FALLBACK_GAS;
    if (simulatedError === null) {
      const estimate = await this.publicClient.estimateGas({
        account: this.address,
        to: this.policy,
        data,
        value,
      });
      gas = (estimate * 12n) / 10n;
    }
    let txHash: Hex;
    try {
      txHash = await this.#wallet.sendTransaction({ to: this.policy, data, value, gas, ...fees });
    } catch (error) {
      return { txHash: null, status: "refused", error: shortError(error), verdict: null, events: [] };
    }
    return this.receipt(txHash, simulatedError);
  }

  /** Signs a proposal without sending it, so the same signed bytes can be broadcast twice. */
  async signProposal(intent: {
    market: string;
    category: number;
    outcome: string;
    isBuy: boolean;
    amountCents: bigint;
    limitPrice: bigint;
  }): Promise<Hex> {
    const data = this.encode({
      functionName: "proposeTrade",
      args: [
        intent.market,
        intent.category,
        intent.outcome,
        intent.isBuy,
        intent.amountCents,
        intent.limitPrice,
      ],
    });
    const fees = applyFeeFloor(
      await this.publicClient.estimateFeesPerGas({ type: "eip1559" }),
      ARC_MIN_MAX_FEE_PER_GAS,
    );
    const request = await this.#wallet.prepareTransactionRequest({
      to: this.policy,
      data,
      gas: FALLBACK_GAS,
      ...fees,
    });
    return this.#wallet.signTransaction(request);
  }

  /** Broadcasts signed bytes. A node that refuses them (for example a reused nonce) gives `refused`. */
  async broadcast(serialized: Hex): Promise<ChainAttempt> {
    let txHash: Hex;
    try {
      txHash = await this.publicClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (error) {
      return { txHash: null, status: "refused", error: shortError(error), verdict: null, events: [] };
    }
    return this.receipt(txHash, null);
  }

  /** The contract's error name for this call from the agent account, or null when it would succeed. */
  private async simulate(data: Hex, value: bigint, functionName?: PolicyWrite): Promise<string | null> {
    try {
      await this.publicClient.call({ account: this.address, to: this.policy, data, value });
      return null;
    } catch (error) {
      if (!(error instanceof BaseError)) return String(error);
      if (functionName !== undefined) {
        const decoded = getContractError(error, {
          abi: policyAbi,
          address: this.policy,
          functionName,
          args: [],
          sender: this.address,
        });
        const name = revertErrorName(decoded);
        if (name !== null) return name;
      }
      return revertDetail(error);
    }
  }

  private async receipt(txHash: Hex, simulatedError: string | null): Promise<ChainAttempt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      pollingInterval: 50,
      timeout: 60_000,
    });
    const logs = parseEventLogs({
      abi: policyAbi,
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.policy.toLowerCase()),
      strict: true,
    });
    let verdict: ChainVerdict | null = null;
    for (const log of logs) {
      if (log.eventName === "IntentApproved") {
        verdict = { kind: "approved", intentId: Number(log.args.intentId) };
      } else if (log.eventName === "IntentNeedsApproval") {
        verdict = { kind: "needs_approval", intentId: Number(log.args.intentId) };
      } else if (log.eventName === "IntentRejected") {
        verdict = { kind: "rejected", intentId: Number(log.args.intentId), reason: log.args.reason };
      }
    }
    const reverted = receipt.status !== "success";
    return {
      txHash,
      status: reverted ? "reverted" : "success",
      error: reverted ? (simulatedError ?? "reverted") : null,
      verdict,
      events: logs.map((log) => log.eventName),
    };
  }
}

/** A revert without a decodable custom error: say so, and include the panic or reason when there is one. */
function revertDetail(error: BaseError): string {
  const text = error.shortMessage;
  if (/without a reason|unknown reason/i.test(text) || /execution reverted\.?$/i.test(text.trim())) {
    return "no reason given";
  }
  return text.split("\n")[0] ?? text;
}

function shortError(error: unknown): string {
  if (error instanceof BaseError) {
    const details = error.details || error.shortMessage;
    return details.split("\n")[0] ?? details;
  }
  return error instanceof Error ? error.message : String(error);
}
