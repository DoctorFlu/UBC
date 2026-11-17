/**
 * Buys hedge signals from the signal API with the agent's Circle Gateway balance, inside a daily
 * budget (issue #21).
 *
 * One purchase, in order:
 * 1. If today's budget is already used up, stop: nothing is contacted.
 * 2. Ask the seller without paying. It answers 402 with its price, or refuses for free (unknown
 *    asset, no such ladder, market data down), in which case nothing is reserved or signed.
 * 3. Refuse a price above the per-call maximum.
 * 4. Reserve the price in the durable ledger, or stop if it does not fit today's budget.
 * 5. Pay with the reserved price as a hard cap, which `X402Buyer` checks before it signs.
 * 6. Check the signal, store it under its receipt id, and record the amount paid. A payment that
 *    did not go through releases the reservation.
 */
import { join } from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  ARC_TESTNET,
  HEDGE_SIGNAL_PATH,
  hedgeSignalSearch,
  signalErrorSchema,
  verifyHedgeSignal,
  type HedgeSignal,
  type HedgeSignalQuery,
  type SignalErrorCode,
} from "@mandate/shared";
import { environmentMismatch, type MarketDataSource } from "@mandate/gemini";
import { formatUnits } from "viem";
import {
  PaymentNotSentError,
  PaymentOutcomeUnknownError,
  PaymentRejectedError,
  PriceAboveMaximumError,
  X402Buyer,
  type GatewayBuyerClient,
} from "./buyer";
import type { PaymentsConfig } from "./payments-config";
import { SignalStore, type SignalPurchase } from "./signal-store";
import { SpendLedger, utcDay } from "./spend-ledger";

type Address = `0x${string}`;

const USDC_DECIMALS = ARC_TESTNET.usdcDecimals;
const PROBE_TIMEOUT_MS = 10_000;

export interface BudgetState {
  /** UTC day the budget applies to, `YYYY-MM-DD`. */
  day: string;
  /** USDC base units. */
  dailyBudget: bigint;
  spent: bigint;
  remaining: bigint;
  /** When the next day's budget starts (00:00 UTC). */
  resetsAt: string;
}

/** One signal payment as the spend ledger records it. */
export interface PaidSignalEntry {
  /** The payment nonce. */
  receiptId: string;
  /** USDC base units paid. */
  amount: bigint;
  /** When the payment was recorded as paid. */
  paidAt: string;
  /** The paid URL. */
  url: string;
}

export type BuySignalOutcome =
  | { kind: "bought"; purchase: SignalPurchase; budget: BudgetState }
  /** Today's budget cannot cover the price (or is used up). Nothing was signed. */
  | { kind: "budget_exhausted"; price: bigint | null; budget: BudgetState }
  /** The seller asks more than the per-call maximum. Nothing was signed. */
  | { kind: "price_above_maximum"; price: bigint; maxPrice: bigint; budget: BudgetState }
  /** The seller refused for free before asking for payment. */
  | { kind: "refused"; code: SignalErrorCode; message: string; budget: BudgetState }
  /** Gateway or the seller turned the signed payment down; nothing was charged. */
  | { kind: "payment_rejected"; reason: string; budget: BudgetState }
  /** The signal API could not be reached before paying. */
  | { kind: "seller_unreachable"; message: string; budget: BudgetState }
  /**
   * The signal API prices another Gemini than the one this server plans on (its free health route says
   * which). Nothing was signed: a signal on the other exchange's ladder would be paid for and misleading.
   */
  | { kind: "environment_mismatch"; message: string; budget: BudgetState }
  /** The paid request failed in a way that leaves it unknown whether it was charged; it counts against the budget. */
  | { kind: "payment_unknown"; message: string; budget: BudgetState };

/** The seller broke the contract (bad 402, malformed signal). A bug, not an expected outcome. */
export class SignalSellerError extends Error {
  override readonly name = "SignalSellerError";
}

export interface SignalPaymentsOptions {
  buyer: X402Buyer;
  ledger: SpendLedger;
  store: SignalStore;
  /** Base URL of the signal API, for example `http://localhost:4021`. */
  signalsUrl: string;
  dailyBudget: bigint;
  maxPrice: bigint;
  /** Used for the free probe; defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * Which Gemini this server plans on. When given, the signal API's free `GET /health` must name the same
   * environment before anything is signed; a signal API that names none reads production.
   */
  marketData?: Pick<MarketDataSource, "environment" | "settings">;
}

export class SignalPayments {
  readonly payer: Address;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SignalPaymentsOptions) {
    this.payer = options.buyer.address;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get dailyBudget(): bigint {
    return this.options.dailyBudget;
  }

  get maxPrice(): bigint {
    return this.options.maxPrice;
  }

  budget(at: Date): BudgetState {
    const day = utcDay(at);
    const spent = this.options.ledger.spentOn(day);
    const remaining = this.options.dailyBudget > spent ? this.options.dailyBudget - spent : 0n;
    const next = new Date(`${day}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { day, dailyBudget: this.options.dailyBudget, spent, remaining, resetsAt: next.toISOString() };
  }

  /** Every signal payment in the spend ledger, oldest first. */
  paidSignals(): PaidSignalEntry[] {
    return this.options.ledger.paidEntries().flatMap((entry) =>
      entry.nonce === null
        ? []
        : [
            {
              receiptId: entry.nonce,
              amount: entry.amount,
              paidAt: entry.paidAt ?? entry.reservedAt,
              url: entry.url,
            },
          ],
    );
  }

  /** The buyer's available Circle Gateway balance, in base units. Throws when it cannot be read. */
  gatewayBalance(): Promise<bigint> {
    return this.options.buyer.gatewayBalance();
  }

  /** The purchase stored under a receipt id, if any. */
  purchasedSignal(receiptId: string): SignalPurchase | undefined {
    return this.options.store.load(receiptId);
  }

  /**
   * `signal` stops the purchase while nothing is signed (the reservation is released and the stop is
   * rethrown); once the payment is signed it runs to its own bound (`PAID_REQUEST_TIMEOUT_MS`) and a
   * payment without an answer is `payment_unknown`. `beforePayment` runs right before signing and may
   * throw to stop it the same way.
   */
  async buySignal(request: {
    query: HedgeSignalQuery;
    at: Date;
    signal?: AbortSignal | undefined;
    beforePayment?: (() => AbortSignal | undefined) | undefined;
  }): Promise<BuySignalOutcome> {
    const { at } = request;
    const url = `${this.options.signalsUrl.replace(/\/+$/, "")}${HEDGE_SIGNAL_PATH}${hedgeSignalSearch(request.query)}`;
    if (this.budget(at).remaining <= 0n) {
      return { kind: "budget_exhausted", price: null, budget: this.budget(at) };
    }

    const agreement = await this.checkEnvironment(request.signal);
    if (agreement !== null) return { ...agreement, budget: this.budget(at) };
    const probe = await this.probe(url, request.signal);
    if (probe.kind !== "price") return { ...probe, budget: this.budget(at) };
    const { price } = probe;
    if (price > this.options.maxPrice) {
      return { kind: "price_above_maximum", price, maxPrice: this.options.maxPrice, budget: this.budget(at) };
    }

    const reservation = this.options.ledger.reserve({
      amount: price,
      budget: this.options.dailyBudget,
      day: utcDay(at),
      url,
      at,
    });
    if (!reservation.ok) return { kind: "budget_exhausted", price, budget: this.budget(at) };

    let paid: Awaited<ReturnType<X402Buyer["pay"]>>;
    try {
      paid = await this.options.buyer.pay(url, {
        maxPrice: formatUnits(price, USDC_DECIMALS),
        signal: request.signal,
        beforeSigning: request.beforePayment,
      });
    } catch (error) {
      if (error instanceof PriceAboveMaximumError) {
        this.options.ledger.release(reservation.id, "price_changed", new Date());
        return {
          kind: "price_above_maximum",
          price: error.requested,
          maxPrice: this.options.maxPrice,
          budget: this.budget(at),
        };
      }
      if (error instanceof PaymentRejectedError) {
        this.options.ledger.release(reservation.id, `rejected: ${error.reason}`, new Date());
        return { kind: "payment_rejected", reason: error.reason, budget: this.budget(at) };
      }
      if (error instanceof PaymentNotSentError) {
        this.options.ledger.release(reservation.id, "not_sent", new Date());
        // The caller stopped it before signing: report the caller's reason, not the seller's.
        if (error.stopped) throw error.cause;
        return {
          kind: "seller_unreachable",
          message:
            "The signal API stopped answering between the price check and the payment; nothing was paid.",
          budget: this.budget(at),
        };
      }
      if (error instanceof PaymentOutcomeUnknownError) {
        // It may have been settled: keep the reservation counted against the budget.
        return {
          kind: "payment_unknown",
          message: `The paid request got no answer; Gateway transfer ${error.nonce} may or may not exist.`,
          budget: this.budget(at),
        };
      }
      throw error;
    }

    const receipt = paid.receipt;
    if (receipt === null) {
      this.options.ledger.release(reservation.id, "served_without_payment", new Date());
      throw new SignalSellerError("The signal API served the signal without asking for payment.");
    }
    this.options.ledger.markPaid(reservation.id, {
      amount: BigInt(receipt.amount),
      nonce: receipt.nonce,
      at: new Date(),
    });
    const signal = paid.data;
    if (!verifyHedgeSignal(signal) || !matchesQuery(signal, request.query)) {
      throw new SignalSellerError(
        `The signal API returned an invalid signal for paid receipt ${receipt.nonce}; the payment is recorded.`,
      );
    }
    const purchase: SignalPurchase = {
      receiptId: receipt.nonce,
      signal,
      receipt: {
        url: receipt.url,
        amount: receipt.amount,
        amountUsdc: receipt.amountUsdc,
        payer: receipt.payer,
        payee: receipt.payee,
        network: receipt.network,
        settlementId: receipt.settlementId,
        paidAt: receipt.paidAt,
      },
    };
    this.options.store.save(purchase);
    return { kind: "bought", purchase, budget: this.budget(at) };
  }

  /** The unpaid request: the seller's price, or why it will not sell. */
  /** Null when the signal API reads the same Gemini as this server (or no environment is configured). */
  private async checkEnvironment(
    signal: AbortSignal | undefined,
  ): Promise<{ kind: "environment_mismatch" | "seller_unreachable"; message: string } | null> {
    const own = this.options.marketData;
    if (own === undefined) return null;
    const origin = new URL(this.options.signalsUrl).origin;
    let body: unknown;
    try {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const response = await this.fetchImpl(`${this.options.signalsUrl.replace(/\/+$/, "")}/health`, {
        headers: { accept: "application/json" },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (!response.ok) {
        return {
          kind: "seller_unreachable",
          message: `The signal API answered HTTP ${response.status} on /health.`,
        };
      }
      body = await response.json();
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      return {
        kind: "seller_unreachable",
        message: `The signal API at ${origin} did not answer (${error instanceof Error ? error.name : "error"}).`,
      };
    }
    const named = (body as { marketEnvironment?: unknown } | null)?.marketEnvironment;
    const theirs = named === "sandbox" ? "sandbox" : "production";
    const mismatch = environmentMismatch(
      { name: "This MCP server", ...own },
      {
        name: `the signal API at ${origin}`,
        environment: theirs,
        settings:
          named === undefined ? "it names no environment, so production" : `its health says ${theirs}`,
      },
    );
    return mismatch === null ? null : { kind: "environment_mismatch", message: mismatch };
  }

  private async probe(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "price"; price: bigint }
    | { kind: "refused"; code: SignalErrorCode; message: string }
    | { kind: "seller_unreachable"; message: string }
  > {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      // The caller stopped (its deadline): say so, rather than blame the signal API.
      if (signal?.aborted === true) throw signal.reason;
      return {
        kind: "seller_unreachable",
        message: `The signal API at ${new URL(url).origin} did not answer (${error instanceof Error ? error.name : "error"}).`,
      };
    }
    if (response.status === 402) return { kind: "price", price: priceFrom(response) };

    const body: unknown = await response.json().catch(() => undefined);
    const refusal = signalErrorSchema.safeParse(body);
    if (refusal.success) return { kind: "refused", code: refusal.data.code, message: refusal.data.error };
    if (response.status >= 500) {
      return { kind: "seller_unreachable", message: `The signal API answered HTTP ${response.status}.` };
    }
    throw new SignalSellerError(`The signal API answered HTTP ${response.status} instead of a price.`);
  }
}

/** The Circle Gateway price on Arc testnet from a 402's `PAYMENT-REQUIRED` header, in base units. */
function priceFrom(response: Response): bigint {
  const header = response.headers.get("payment-required");
  if (header === null) throw new SignalSellerError("The signal API sent a 402 without payment requirements.");
  let required: { accepts?: unknown };
  try {
    required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: unknown };
  } catch {
    throw new SignalSellerError("The signal API sent unreadable payment requirements.");
  }
  const accepts = Array.isArray(required.accepts) ? (required.accepts as Record<string, unknown>[]) : [];
  const option = accepts.find(
    (a) =>
      a["scheme"] === "exact" &&
      a["network"] === ARC_TESTNET.network &&
      typeof a["asset"] === "string" &&
      a["asset"].toLowerCase() === ARC_TESTNET.usdc.toLowerCase() &&
      (a["extra"] as { name?: unknown } | undefined)?.name === "GatewayWalletBatched",
  );
  const amount = option?.["amount"];
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || amount === "0") {
    throw new SignalSellerError("The signal API offers no Circle Gateway USDC price on Arc testnet.");
  }
  return BigInt(amount);
}

function matchesQuery(signal: HedgeSignal, query: HedgeSignalQuery): boolean {
  if (signal.asset !== query.asset) return false;
  if (query.eventTicker !== undefined && signal.eventTicker !== query.eventTicker) return false;
  if (query.expiry !== undefined && Date.parse(signal.expiry) !== Date.parse(query.expiry)) return false;
  if (query.horizon !== undefined && signal.horizon !== query.horizon) return false;
  return true;
}

/** Builds the payments service from configuration, or undefined when no buyer key is set. */
export function createSignalPayments(config: {
  payments: PaymentsConfig;
  signalsUrl: string;
  marketData?: Pick<MarketDataSource, "environment" | "settings">;
}): SignalPayments | undefined {
  const key = config.payments.buyerPrivateKey;
  if (key === undefined) return undefined;
  const client: GatewayBuyerClient = new GatewayClient({ chain: "arcTestnet", privateKey: key.reveal() });
  return new SignalPayments({
    buyer: new X402Buyer(client),
    ledger: SpendLedger.open(join(config.payments.dataDir, "signal-spend.jsonl")),
    store: SignalStore.open(join(config.payments.dataDir, "signals")),
    signalsUrl: config.signalsUrl,
    ...(config.marketData === undefined ? {} : { marketData: config.marketData }),
    dailyBudget: BigInt(config.payments.dailyBudgetBaseUnits),
    maxPrice: BigInt(config.payments.maxPriceBaseUnits),
  });
}
