import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Balances,
  DepositResult,
  GatewayClient,
  PayResult,
  SearchTransfersParams,
  SearchTransfersResponse,
} from "@circle-fin/x402-batching/client";
import { ARC_TESTNET } from "@mandate/shared";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";

const USDC_DECIMALS = ARC_TESTNET.usdcDecimals;

type BeforePaymentCreationHook = Parameters<GatewayClient["onBeforePaymentCreation"]>[0];
type AfterPaymentCreationHook = Parameters<GatewayClient["onAfterPaymentCreation"]>[0];
type PaymentResponseHook = Parameters<GatewayClient["onPaymentResponse"]>[0];
type PayOptions = NonNullable<Parameters<GatewayClient["pay"]>[1]>;

/**
 * The part of Circle's `GatewayClient` the buyer uses.
 * `GatewayClient` satisfies it; tests pass a fake.
 */
export interface GatewayBuyerClient {
  readonly address: Address;
  getBalances(): Promise<Balances>;
  deposit(amount: string): Promise<DepositResult>;
  pay<T = unknown>(url: string, options?: PayOptions): Promise<PayResult<T>>;
  searchTransfers(params?: SearchTransfersParams): Promise<SearchTransfersResponse>;
  onBeforePaymentCreation(hook: BeforePaymentCreationHook): unknown;
  onAfterPaymentCreation(hook: AfterPaymentCreationHook): unknown;
  onPaymentResponse(hook: PaymentResponseHook): unknown;
}

/** What one paid request cost and where to find it later. */
export interface X402Receipt {
  url: string;
  /** Amount in USDC base units (6 decimals). */
  amount: string;
  /** Amount in USDC as a decimal string. */
  amountUsdc: string;
  asset: Address;
  payer: Address;
  payee: Address;
  /** CAIP-2 network, for example `eip155:5042002`. */
  network: string;
  /** EIP-3009 nonce of the signed authorization; look the transfer up with `searchTransfers({ nonce })`. */
  nonce: Hex;
  /** `transaction` from the seller's PAYMENT-RESPONSE header: for Gateway this is a settlement reference, not an onchain hash. */
  settlementId: string | null;
  /** Unix seconds after which the authorization can no longer be settled. */
  validBefore: string;
  /** ISO time the paid response arrived. */
  paidAt: string;
  /** Wall time of the whole pay call (402, sign, paid retry) in milliseconds. */
  latencyMs: number;
}

export interface PaidResponse<T> {
  status: number;
  data: T;
  /** Null when the resource turned out to be free (no 402). */
  receipt: X402Receipt | null;
}

export interface PayRequestOptions extends PayOptions {
  /** Most this one call may pay, in USDC as a decimal string, for example `"0.001"`. */
  maxPrice: string;
}

export interface EnsureDepositOptions {
  /** Deposit when the Gateway available balance is below this many USDC. */
  minAvailable: string;
  /** How many USDC to deposit when topping up. */
  depositAmount: string;
  /** How long to wait for Gateway to credit the deposit. Defaults to 120 s. */
  timeoutMs?: number;
  pollMs?: number;
}

export interface EnsureDepositResult {
  deposited: boolean;
  /** Gateway available balance after the call, in USDC base units. */
  available: bigint;
  depositTxHash?: Hex;
  approvalTxHash?: Hex;
  /** Time from sending the deposit to Gateway showing it as available. */
  creditedAfterMs?: number;
}

/** Thrown before anything is signed when the seller asks for more than the per-call maximum. */
export class PriceAboveMaximumError extends Error {
  constructor(
    readonly url: string,
    readonly requested: bigint,
    readonly maximum: bigint,
  ) {
    super(
      `Refused to pay ${formatUnits(requested, USDC_DECIMALS)} USDC for ${url}: ` +
        `the per-call maximum is ${formatUnits(maximum, USDC_DECIMALS)} USDC`,
    );
    this.name = "PriceAboveMaximumError";
  }
}

/**
 * The seller (through Circle Gateway) rejected a signed payment, for example with
 * `insufficient_balance` when the Gateway deposit is too small. The resource was not served.
 */
export class PaymentRejectedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Payment for ${url} was rejected: ${reason}`, options);
    this.name = "PaymentRejectedError";
  }
}

/** The request failed before any authorization was signed (for example the seller refused the unpaid request). */
export class PaymentNotSentError extends Error {
  constructor(
    readonly url: string,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause instanceof Error ? `: ${options.cause.message}` : "";
    super(`Nothing was paid for ${url}${cause}`, options);
    this.name = "PaymentNotSentError";
  }
}

/**
 * An authorization was signed and sent, but no answer came back, so it is unknown whether Gateway
 * settled it. Look it up later by `nonce` with `transferFor`.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    readonly url: string,
    readonly nonce: Hex,
    options?: ErrorOptions,
  ) {
    super(`The paid request for ${url} failed without an answer; check Gateway transfer ${nonce}`, options);
    this.name = "PaymentOutcomeUnknownError";
  }
}

export class InsufficientWalletBalanceError extends Error {
  constructor(
    readonly address: Address,
    readonly have: bigint,
    readonly need: bigint,
  ) {
    super(
      `Wallet ${address} holds ${formatUnits(have, USDC_DECIMALS)} USDC on Arc testnet and needs ` +
        `${formatUnits(need, USDC_DECIMALS)} USDC (deposit plus gas). Fund it at https://faucet.circle.com`,
    );
    this.name = "InsufficientWalletBalanceError";
  }
}

interface CallState {
  url: string;
  maxAmount: bigint;
  refused?: PriceAboveMaximumError;
  requirements?: { network: string; asset: string; payTo: string; amount: string };
  authorization?: { from: string; to: string; value: string; validBefore: string; nonce: string };
  settlement?: {
    success: boolean;
    errorReason?: string;
    transaction?: string;
    payer?: string;
    network?: string;
  };
}

type Authorization = NonNullable<CallState["authorization"]>;

function readAuthorization(value: unknown): Authorization | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const { from, to, value: amount, validBefore, nonce } = fields;
  if (
    typeof from === "string" &&
    typeof to === "string" &&
    typeof amount === "string" &&
    typeof validBefore === "string" &&
    typeof nonce === "string"
  ) {
    return { from, to, value: amount, validBefore, nonce };
  }
  return undefined;
}

/** Gas headroom kept in the wallet on top of a deposit (approve plus deposit cost about 0.005 USDC). */
const GAS_HEADROOM = parseUnits("0.01", USDC_DECIMALS);

/**
 * Pays x402 resources from a Circle Gateway balance with a hard per-call price cap.
 * The cap is checked in Circle's `onBeforePaymentCreation` hook, which runs before the authorization is signed.
 * Per-call state lives in AsyncLocalStorage, so concurrent calls on one client do not see each other's caps.
 */
export class X402Buyer {
  private readonly calls = new AsyncLocalStorage<CallState>();

  constructor(private readonly client: GatewayBuyerClient) {
    client.onBeforePaymentCreation((ctx) => {
      const call = this.calls.getStore();
      if (!call) return Promise.resolve({ abort: true, reason: "payment attempted outside X402Buyer.pay" });
      const requested = BigInt(ctx.selectedRequirements.amount);
      if (requested > call.maxAmount) {
        call.refused = new PriceAboveMaximumError(call.url, requested, call.maxAmount);
        return Promise.resolve({ abort: true, reason: call.refused.message });
      }
      return Promise.resolve();
    });
    client.onAfterPaymentCreation((ctx) => {
      const call = this.calls.getStore();
      const authorization = readAuthorization(ctx.paymentPayload.payload.authorization);
      if (call && authorization) {
        call.requirements = ctx.selectedRequirements;
        call.authorization = authorization;
      }
      return Promise.resolve();
    });
    client.onPaymentResponse((ctx) => {
      const call = this.calls.getStore();
      if (call && ctx.settleResponse) call.settlement = ctx.settleResponse;
      return Promise.resolve();
    });
  }

  get address(): Address {
    return this.client.address;
  }

  /** The Circle Gateway balance available to pay with, in USDC base units. */
  async gatewayBalance(): Promise<bigint> {
    return (await this.client.getBalances()).gateway.available;
  }

  /** Makes sure the Gateway balance can cover payments, depositing from the wallet when it is low. */
  async ensureDeposit(options: EnsureDepositOptions): Promise<EnsureDepositResult> {
    const minAvailable = parseUnits(options.minAvailable, USDC_DECIMALS);
    const depositAmount = parseUnits(options.depositAmount, USDC_DECIMALS);
    const before = await this.client.getBalances();
    if (before.gateway.available >= minAvailable) {
      return { deposited: false, available: before.gateway.available };
    }
    const need = depositAmount + GAS_HEADROOM;
    if (before.wallet.balance < need) {
      throw new InsufficientWalletBalanceError(this.client.address, before.wallet.balance, need);
    }
    const sentAt = Date.now();
    const result = await this.client.deposit(options.depositAmount);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 2_000;
    for (;;) {
      const now = await this.client.getBalances();
      if (now.gateway.available >= minAvailable) {
        return {
          deposited: true,
          available: now.gateway.available,
          depositTxHash: result.depositTxHash,
          ...(result.approvalTxHash ? { approvalTxHash: result.approvalTxHash } : {}),
          creditedAfterMs: Date.now() - sentAt,
        };
      }
      if (Date.now() - sentAt > timeoutMs) {
        throw new Error(
          `Deposit ${result.depositTxHash} was not credited by Gateway within ${timeoutMs} ms; check again with x402:status`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Pays for `url` if the seller's price is at most `maxPrice`, and returns the response with a receipt. */
  async pay<T = unknown>(url: string, options: PayRequestOptions): Promise<PaidResponse<T>> {
    const { maxPrice, ...payOptions } = options;
    const state: CallState = { url, maxAmount: parseUnits(maxPrice, USDC_DECIMALS) };
    const started = performance.now();
    let result: PayResult<T>;
    try {
      result = await this.calls.run(state, () => this.client.pay<T>(url, payOptions));
    } catch (error) {
      if (state.refused) throw state.refused;
      // Nothing was signed, so nothing can be charged: the 402 request itself failed.
      if (!state.authorization) throw new PaymentNotSentError(url, { cause: error });
      // Signed and answered but not served: the seller or Gateway turned the payment down
      // (verify or settle failed, or the seller refused the paid retry).
      const fromHeader = state.settlement?.success === false ? state.settlement.errorReason : undefined;
      const answered = error instanceof Error && error.message.startsWith("Payment failed: ");
      if (fromHeader !== undefined || answered) {
        const fromBody = error instanceof Error ? error.message.replace(/^Payment failed: /, "") : undefined;
        throw new PaymentRejectedError(url, fromHeader ?? fromBody ?? "unknown", { cause: error });
      }
      // Signed, but the paid request failed without an answer: it may or may not have been settled.
      throw new PaymentOutcomeUnknownError(url, state.authorization.nonce as Hex, { cause: error });
    }
    const latencyMs = Math.round(performance.now() - started);
    const { requirements, authorization } = state;
    if (!requirements || !authorization) {
      return { status: result.status, data: result.data, receipt: null };
    }
    const settlementId = state.settlement?.transaction ?? (result.transaction || null);
    return {
      status: result.status,
      data: result.data,
      receipt: {
        url,
        amount: authorization.value,
        amountUsdc: formatUnits(BigInt(authorization.value), USDC_DECIMALS),
        asset: requirements.asset as Address,
        payer: authorization.from as Address,
        payee: authorization.to as Address,
        network: requirements.network,
        nonce: authorization.nonce as Hex,
        settlementId: settlementId === "" ? null : settlementId,
        validBefore: authorization.validBefore,
        paidAt: new Date().toISOString(),
        latencyMs,
      },
    };
  }

  /** Looks up the Gateway transfer for a receipt: status `received`, then `batched`, `confirmed`, `completed` (or `failed`). */
  async transferFor(receipt: X402Receipt) {
    const { transfers } = await this.client.searchTransfers({
      nonce: receipt.nonce,
      network: receipt.network,
    });
    return transfers[0] ?? null;
  }
}
