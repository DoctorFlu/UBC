/**
 * The services one tool call sees (issue #105): the process-wide services with every upstream method
 * run as a named step of the call's deadline, under its signal. Tools use them as they always have;
 * none can forget to pass the signal, and when the call is stopped, the answer and the log say which
 * step was slow.
 */
import type { AgentPolicy, ConsoleClient, MarketsClient, PaymentsClient, Services } from "../services";
import type { PaymentReporter } from "../console/payment-reports";
import type { CallDeadline, Commit } from "./deadline";

/**
 * Time a proposal needs once it is broadcast: the wait for its receipt (`RECEIPT_TIMEOUT_MS`) and a
 * margin. A proposal is broadcast only while this much of the call's budget is left.
 */
export const PROPOSAL_RESERVE_MS = 12_000;
/** Time a signal payment needs once signed (`PAID_REQUEST_TIMEOUT_MS` and a margin), likewise. */
export const PAYMENT_RESERVE_MS = 12_000;

/** A reserve scaled down for a short budget, so a call with a small budget can still do one commit. */
export function reserveWithin(reserveMs: number, budgetMs: number): number {
  return Math.min(reserveMs, Math.floor(budgetMs / 2));
}

/** Combines the call's signal with one a caller passed for a single request (a shorter timeout). */
function both(call: AbortSignal, own: AbortSignal | undefined): AbortSignal {
  return own === undefined ? call : AbortSignal.any([call, own]);
}

function scopedPolicy(policy: AgentPolicy, deadline: CallDeadline): AgentPolicy {
  const proposalReserve = reserveWithin(PROPOSAL_RESERVE_MS, deadline.budgetMs);
  return {
    policyAddress: policy.policyAddress,
    agentAddress: policy.agentAddress,
    capabilities: () => deadline.step("chain.capabilities", (signal) => policy.capabilities(signal)),
    snapshot: () => deadline.step("chain.snapshot", (signal) => policy.snapshot(signal)),
    roles: () => deadline.step("chain.roles", (signal) => policy.roles(signal)),
    agentGasBalance: () => deadline.step("chain.balance", (signal) => policy.agentGasBalance(signal)),
    intentCount: () => deadline.step("chain.intent_count", (signal) => policy.intentCount(signal)),
    intent: (id) => deadline.step("chain.intent", (signal) => policy.intent(id, signal)),
    intentEvents: () => deadline.step("chain.events", (signal) => policy.intentEvents(signal)),
    preview: (input) => deadline.step("chain.preview", (signal) => policy.preview(input, signal)),
    // Broadcast only with enough time left for the receipt. After that, neither the deadline nor the
    // client cuts it: only the commit's bound, which ends in "no receipt" (TX_UNCONFIRMED).
    propose: (input) =>
      deadline.step("chain.propose", async (signal) => {
        let commit: Commit | undefined;
        try {
          return await policy.propose(input, {
            signal,
            beforeBroadcast: () => {
              commit = deadline.beginCommit(proposalReserve);
              return commit.bound;
            },
          });
        } finally {
          commit?.end();
        }
      }),
    explorerTxUrl: (txHash) => policy.explorerTxUrl(txHash),
  };
}

function scopedMarkets(markets: MarketsClient, deadline: CallDeadline): MarketsClient {
  return {
    venue: markets.venue,
    listEvents: (options) => deadline.step("gemini.events", (signal) => markets.listEvents(options, signal)),
    getEvent: (ticker) => deadline.step("gemini.event", (signal) => markets.getEvent(ticker, signal)),
    listLadders: (asset) => deadline.step("gemini.ladders", (signal) => markets.listLadders(asset, signal)),
    getLadder: (options) => deadline.step("gemini.ladder", (signal) => markets.getLadder(options, signal)),
    getSpot: (asset) => deadline.step("gemini.spot", (signal) => markets.getSpot(asset, signal)),
    resolveMarket: (symbol) =>
      deadline.step("gemini.market", (signal) => markets.resolveMarket(symbol, signal)),
  };
}

function scopedConsole(client: ConsoleClient, deadline: CallDeadline): ConsoleClient {
  return {
    baseUrl: client.baseUrl,
    // The client already names the agent the call's token resolved to (docs/accounts.md); the call's
    // deadline binds whichever agent it acts for.
    agentId: client.agentId,
    forAgent: (agentId) => scopedConsole(client.forAgent(agentId), deadline),
    getHoldings: (own) =>
      deadline.step("console.holdings", (signal) => client.getHoldings(both(signal, own))),
    putContext: (hash, document, own) =>
      deadline.step("console.context", (signal) => client.putContext(hash, document, both(signal, own))),
    getContext: (hash, own) =>
      deadline.step("console.context", (signal) => client.getContext(hash, both(signal, own))),
    putIntentContext: (intentId, request, own) =>
      deadline.step("console.intent_context", (signal) =>
        client.putIntentContext(intentId, request, both(signal, own)),
      ),
    postPlan: (request, own) =>
      deadline.step("console.plan", (signal) => client.postPlan(request, both(signal, own))),
    postPolicyChangeRequest: (request, own) =>
      deadline.step("console.change_request", (signal) =>
        client.postPolicyChangeRequest(request, both(signal, own)),
      ),
    putPairing: (request, own) =>
      deadline.step("console.pairing", (signal) => client.putPairing(request, both(signal, own))),
    getPairing: (own) => deadline.step("console.pairing", (signal) => client.getPairing(both(signal, own))),
    getMarketEnvironment: (own) =>
      deadline.step("console.health", (signal) => client.getMarketEnvironment(both(signal, own))),
    putSignalPayment: (receiptId, request, own) =>
      deadline.step("console.signal_payment", (signal) =>
        client.putSignalPayment(receiptId, request, both(signal, own)),
      ),
    putSignalBudget: (request, own) =>
      deadline.step("console.signal_budget", (signal) => client.putSignalBudget(request, both(signal, own))),
    getSettlements: (own) =>
      deadline.step("console.settlements", (signal) => client.getSettlements(both(signal, own))),
    getOrders: (own) => deadline.step("console.orders", (signal) => client.getOrders(both(signal, own))),
    getSummary: (own) => deadline.step("console.summary", (signal) => client.getSummary(both(signal, own))),
  };
}

function scopedPayments(payments: PaymentsClient, deadline: CallDeadline): PaymentsClient {
  const paymentReserve = reserveWithin(PAYMENT_RESERVE_MS, deadline.budgetMs);
  return {
    payer: payments.payer,
    dailyBudget: payments.dailyBudget,
    maxPrice: payments.maxPrice,
    budget: (at) => payments.budget(at),
    // Pay only with enough time left for the payment's own bound, and never cut it after that.
    buySignal: (request) =>
      deadline.step("signals.buy", async (signal) => {
        let commit: Commit | undefined;
        try {
          return await payments.buySignal({
            ...request,
            signal,
            beforePayment: () => {
              commit = deadline.beginCommit(paymentReserve);
              return commit.bound;
            },
          });
        } finally {
          commit?.end();
        }
      }),
    purchasedSignal: (receiptId) => payments.purchasedSignal(receiptId),
    paidSignals: () => payments.paidSignals(),
    gatewayBalance: () => payments.gatewayBalance(),
  };
}

function scopedReports(
  reports: PaymentReporter,
  deadline: CallDeadline,
): Pick<PaymentReporter, "reportPurchase" | "syncBudget"> {
  // Reports run after a payment: like the reporter itself they never throw, even once the call is
  // stopped. An unsent report stays pending and the reporter's background flush sends it.
  const quietly = (report: Promise<boolean>) => report.catch(() => false);
  return {
    reportPurchase: (receiptId) =>
      quietly(deadline.step("console.signal_payment", (signal) => reports.reportPurchase(receiptId, signal))),
    syncBudget: () => quietly(deadline.step("console.signal_budget", (signal) => reports.syncBudget(signal))),
  };
}

export type ScopedServices = Pick<Services, "policy" | "markets" | "console" | "payments"> & {
  readonly paymentReports: Pick<PaymentReporter, "reportPurchase" | "syncBudget"> | undefined;
};

/** The upstream services of one call, bound to its deadline. */
export function scopedServices(services: Services, deadline: CallDeadline): ScopedServices {
  return {
    policy: services.policy === undefined ? undefined : scopedPolicy(services.policy, deadline),
    markets: services.markets === undefined ? undefined : scopedMarkets(services.markets, deadline),
    console: services.console === undefined ? undefined : scopedConsole(services.console, deadline),
    payments: services.payments === undefined ? undefined : scopedPayments(services.payments, deadline),
    paymentReports:
      services.paymentReports === undefined ? undefined : scopedReports(services.paymentReports, deadline),
  };
}
