/**
 * Reports the agent's signal payments and its signal budget to the console (issue #22), best effort.
 *
 * The spend ledger is the source of truth and doubles as the outbox: every paid entry the console has
 * not confirmed in this process is sent again later, when the server starts, after each purchase, and
 * every minute while something is pending. The console's PUT is idempotent on the receipt id, so a
 * resend never duplicates, and resending everything once per start also refills a console whose store
 * was reset. Nothing here can fail or slow a purchase beyond a short bound: every request has a
 * timeout, an unanswered one is retried once, and every failure is logged and reported as "not
 * recorded", never thrown.
 *
 * A console that does not serve these routes yet answers 404. That is "not recorded yet", logged at
 * debug level only, and retried like any other pending report.
 *
 * Only public data leaves: amounts, times, addresses, the receipt id (the payment nonce), Gateway's
 * settlement reference and what was bought. Never a key and never the payment signature.
 */
import { ARC_TESTNET, type PutSignalBudgetRequest, type PutSignalPaymentRequest } from "@mandate/shared";
import type { Clock } from "../context";
import { scrubText, type Logger } from "../logger";
import type { ConsoleClient, PaymentsClient } from "../services";
import type { PaidSignalEntry } from "../x402/payments";
import { receiptIdSchema } from "../x402/signal-store";
import { utcDay } from "../x402/spend-ledger";
import { ConsoleClientError } from "./client";

/** Most one request to the console may take. */
export const REPORT_TIMEOUT_MS = 3_000;
/** Pause before the one retry of a request the console did not answer. */
export const REPORT_RETRY_DELAY_MS = 200;
/** How often pending reports are retried in the background. */
export const REPORT_RETRY_INTERVAL_MS = 60_000;
/** Most reading the Gateway balance for a snapshot may take; the snapshot goes without it after that. */
export const BALANCE_TIMEOUT_MS = 3_000;

/**
 * What the console did with one report:
 * - `recorded`: it answered 2xx;
 * - `not_yet`: it has no such route yet (404); send again later;
 * - `pending`: it did not answer, refused the token, or answered off contract; send again later;
 * - `refused`: it refused the body (422 or 409), so resending the same body cannot help.
 */
type Delivery = "recorded" | "not_yet" | "pending" | "refused";

export class PaymentReporter {
  readonly #console: ConsoleClient;
  readonly #payments: PaymentsClient;
  readonly #logger: Logger;
  readonly #clock: Clock;
  /** Receipt ids (lower case) the console confirmed, or refused for good. */
  readonly #settled = new Set<string>();
  /** UTC day of the last snapshot the console stored, or null when none was stored by this process. */
  #budgetDay: string | null = null;
  #flushing: Promise<void> | undefined;
  /** The last failure logged as a warning, so a console that stays down does not flood the log. */
  #lastProblem: string | null = null;

  constructor(options: { console: ConsoleClient; payments: PaymentsClient; logger: Logger; clock: Clock }) {
    this.#console = options.console;
    this.#payments = options.payments;
    this.#logger = options.logger;
    this.#clock = options.clock;
  }

  /**
   * Reports a purchase that just happened, together with a fresh budget snapshot. Returns true when
   * the console has the payment on record. Never throws.
   */
  async reportPurchase(receiptId: string): Promise<boolean> {
    try {
      const entry = this.#payments
        .paidSignals()
        .find((paid) => paid.receiptId.toLowerCase() === receiptId.toLowerCase());
      if (entry === undefined) {
        this.#logger.error("payments.report_missing_entry", { reason: "no paid ledger entry" });
        return false;
      }
      const [delivery] = await Promise.all([this.#deliverPayment(entry), this.syncBudget()]);
      // The console answers: send what it missed earlier, without holding up this result.
      if (delivery === "recorded" && this.pending()) void this.flush();
      return delivery === "recorded";
    } catch (error) {
      this.#logger.error("payments.report_failed", { message: describe(error) });
      return false;
    }
  }

  /** Sends the current budget snapshot. Returns true when the console stored it. Never throws. */
  async syncBudget(): Promise<boolean> {
    try {
      const snapshot = await this.#snapshot();
      const delivery = await this.#attempt("budget", (signal) =>
        this.#console.putSignalBudget(snapshot, signal),
      );
      if (delivery === "recorded") this.#budgetDay = snapshot.day;
      return delivery === "recorded";
    } catch (error) {
      this.#logger.error("payments.report_failed", { what: "budget", message: describe(error) });
      return false;
    }
  }

  /** True while a payment, or a snapshot for the current UTC day, has not reached the console. */
  pending(): boolean {
    if (this.#budgetDay !== utcDay(this.#clock.now())) return true;
    return this.#payments.paidSignals().some((paid) => !this.#settled.has(paid.receiptId.toLowerCase()));
  }

  /**
   * Delivers every pending payment, oldest first, then the snapshot when the console lacks today's.
   * Stops sending payments at the first the console cannot take now. One flush runs at a time; a
   * second caller waits for the running one. Never throws.
   */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  /**
   * Flushes now and then every `intervalMs` while something is pending. Returns a function that
   * stops the timer. The timer never keeps the process alive.
   */
  start(intervalMs = REPORT_RETRY_INTERVAL_MS): () => void {
    void this.flush();
    const timer = setInterval(() => {
      if (this.pending()) void this.flush();
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  async #flush(): Promise<void> {
    try {
      for (const entry of this.#payments.paidSignals()) {
        if (this.#settled.has(entry.receiptId.toLowerCase())) continue;
        const delivery = await this.#deliverPayment(entry);
        if (delivery === "pending" || delivery === "not_yet") break;
      }
      if (this.#budgetDay !== utcDay(this.#clock.now())) await this.syncBudget();
    } catch (error) {
      this.#logger.error("payments.report_failed", { message: describe(error) });
    }
  }

  async #deliverPayment(entry: PaidSignalEntry): Promise<Delivery> {
    const id = entry.receiptId.toLowerCase();
    if (!receiptIdSchema.safeParse(entry.receiptId).success) {
      this.#logger.error("payments.report_refused", { what: "payment", reason: "not a receipt id" });
      this.#settled.add(id);
      return "refused";
    }
    const delivery = await this.#attempt("payment", (signal) =>
      this.#console.putSignalPayment(entry.receiptId, this.#record(entry), signal),
    );
    if (delivery === "recorded" || delivery === "refused") this.#settled.add(id);
    if (delivery === "recorded") this.#logger.info("payments.reported", { amount: entry.amount.toString() });
    return delivery;
  }

  /** The record for one paid entry, the same whether it is sent right after the purchase or later. */
  #record(entry: PaidSignalEntry): PutSignalPaymentRequest {
    const purchase = this.#payments.purchasedSignal(entry.receiptId);
    const signal = purchase?.signal;
    return {
      amount: entry.amount.toString(),
      paidAt: purchase?.receipt.paidAt ?? entry.paidAt,
      resource: resourceOf(entry.url),
      network: purchase?.receipt.network ?? ARC_TESTNET.network,
      payer: (purchase?.receipt.payer ?? this.#payments.payer) as `0x${string}`,
      payee: (purchase?.receipt.payee ?? null) as `0x${string}` | null,
      settlementId: purchase?.receipt.settlementId ?? null,
      signal:
        signal === undefined
          ? null
          : {
              signalId: signal.signalId as `0x${string}`,
              asset: signal.asset,
              eventTicker: signal.eventTicker,
              horizon: signal.horizon,
              expiry: signal.expiry,
              asOf: signal.asOf,
              counts: signal.counts,
            },
    };
  }

  async #snapshot(): Promise<PutSignalBudgetRequest> {
    const now = this.#clock.now();
    const budget = this.#payments.budget(now);
    const balance = await withTimeout(this.#payments.gatewayBalance(), BALANCE_TIMEOUT_MS).catch(
      (error: unknown) => {
        this.#logger.debug("payments.balance_unknown", { message: describe(error) });
        return null;
      },
    );
    return {
      buyerAddress: this.#payments.payer,
      day: budget.day,
      dailyBudget: budget.dailyBudget.toString(),
      spentToday: budget.spent.toString(),
      maxPricePerPurchase: this.#payments.maxPrice.toString(),
      resetsAt: budget.resetsAt,
      gatewayBalance: balance === null ? null : balance.toString(),
      asOf: now.toISOString(),
    };
  }

  /** One request with a bounded timeout and one retry when the console does not answer. */
  async #attempt(
    what: "payment" | "budget",
    call: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<Delivery> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await call(AbortSignal.timeout(REPORT_TIMEOUT_MS));
        if (answer === null) {
          this.#logger.debug("payments.console_route_missing", { what });
          return "not_yet";
        }
        this.#lastProblem = null;
        return "recorded";
      } catch (error) {
        const kind = error instanceof ConsoleClientError ? error.kind : "invalid";
        if (kind === "unreachable" && attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS));
          continue;
        }
        const refused = kind === "rejected" || kind === "conflict" || kind === "invalid";
        const fields = {
          what,
          kind,
          status: error instanceof ConsoleClientError ? (error.status ?? null) : null,
          code: error instanceof ConsoleClientError ? (error.code ?? null) : null,
          message: describe(error),
          willRetry: !refused,
        };
        const problem = `${what}:${kind}:${String(fields.status)}`;
        if (refused) this.#logger.error("payments.report_failed", fields);
        else if (problem !== this.#lastProblem) this.#logger.warn("payments.report_failed", fields);
        else this.#logger.debug("payments.report_failed", fields);
        this.#lastProblem = problem;
        return refused ? "refused" : "pending";
      }
    }
  }
}

/** The reporter for these services, or undefined unless both the console and payments are configured. */
export function createPaymentReporter(
  services: { console: ConsoleClient | undefined; payments: PaymentsClient | undefined },
  logger: Logger,
  clock: Clock,
): PaymentReporter | undefined {
  if (services.console === undefined || services.payments === undefined) return undefined;
  return new PaymentReporter({ console: services.console, payments: services.payments, logger, clock });
}

/** Path and query of a paid URL; the host is left out on purpose. */
function resourceOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? scrubText(error.message).slice(0, 300) : "unknown error";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
