/**
 * Service interfaces tool handlers depend on.
 *
 * Each interface names one dependency and carries only what the tools need, so tests can pass a
 * small fake. A service is `undefined` when the configuration it needs is missing, so a tool can
 * answer with an `unavailable` verdict instead of failing. Process-wide state that must survive
 * between tool calls (Grok Bot opens a fresh MCP session for every call) lives in `plans` and
 * `ledger`, which always exist.
 */
import type {
  EventSummary,
  GetLadderOptions,
  Ladder,
  LadderListing,
  MarketEvent,
  SpotPrice,
  GeminiEnvironment,
} from "@mandate/gemini";
import type { HedgeInput, HedgePlan } from "@mandate/planner";
import type {
  Capabilities as ContractCapabilities,
  ContextResponse,
  DecisionContext,
  HedgeSignalQuery,
  HoldingsResponse,
  Intent,
  IntentContextResponse,
  IntentView,
  PairingResponse,
  PlanResponse,
  PolicyChangeRequest,
  PolicySnapshot,
  PostPlanRequest,
  PostPolicyChangeRequest,
  PreviewResult,
  ProposeResult,
  PutIntentContextRequest,
  PutPairingRequest,
  PutSignalBudgetRequest,
  PutSignalPaymentRequest,
  Roles,
  SettlementsResponse,
  SignalBudgetResponse,
  SignalPaymentResponse,
  RuleInput,
  TradeIntentInput,
} from "@mandate/shared";
import { createAgentPolicy } from "./chain/agent-policy";
import type { Address, Config } from "./config";
import { createConsoleClient } from "./console/client";
import { createGeminiMarkets, type ResolvedMarket } from "./markets/gemini";
import { createHedgePlanner } from "./planning/planner";
import { ProposalLedger } from "./state/ledger";
import { PlanStore } from "./state/plans";
import type { PaymentReporter } from "./console/payment-reports";
import {
  createSignalPayments,
  type BudgetState,
  type BuySignalOutcome,
  type PaidSignalEntry,
} from "./x402/payments";
import type { SignalPurchase } from "./x402/signal-store";

/** How a proposal may be stopped. See `WriteOptions` in `@mandate/shared`. */
export interface ProposeOptions {
  /** Stops the proposal while it has not been broadcast. Never cuts a broadcast or its receipt wait. */
  signal?: AbortSignal | undefined;
  /**
   * Called right before the broadcast. It may throw, and then nothing is sent. It may return the most
   * the broadcast and the receipt wait may take; past it the proposal is reported unconfirmed.
   */
  beforeBroadcast?: (() => AbortSignal | undefined) | undefined;
}

/**
 * The agent's view of the onchain Policy contract (issues #10, #11, #32, #33).
 *
 * It is deliberately narrow: reads, a preview, and `propose`, the agent role's only write. There is
 * no method that changes the policy, pauses or unpauses, approves or rejects an intent, changes a
 * role or records a result, so no tool can reach one. `test/no-owner-calls.test.ts` enforces this.
 *
 * Every read takes an optional abort signal (issue #105): its RPC requests are aborted when it fires.
 */
export interface AgentPolicy {
  readonly policyAddress: Address;
  /** The agent's public address, or undefined when no agent key is configured (read-only). */
  readonly agentAddress: Address | undefined;
  /** Which optional contract extensions the deployed contract has (detected once, then cached). */
  capabilities(signal?: AbortSignal): Promise<ContractCapabilities>;
  /** Rules, committed spend and today's loss, read at one block. */
  snapshot(signal?: AbortSignal): Promise<PolicySnapshot>;
  roles(signal?: AbortSignal): Promise<Roles>;
  /** The agent's native gas balance in wei (Arc pays gas in USDC, 18 decimals), or null without a key. */
  agentGasBalance(signal?: AbortSignal): Promise<bigint | null>;
  intentCount(signal?: AbortSignal): Promise<number>;
  /** The stored intent, or null when no intent has this id. */
  intent(id: number, signal?: AbortSignal): Promise<Intent | null>;
  /** Intents as the event log describes them, for the blocks this server has scanned. */
  intentEvents(signal?: AbortSignal): Promise<ReadonlyMap<number, IntentView>>;
  /** The contract's `previewTrade` when it has one, otherwise the TypeScript evaluator on a fresh snapshot. */
  preview(input: RuleInput, signal?: AbortSignal): Promise<PreviewResult>;
  /** Submits one intent from the agent key. Throws when no agent key is configured. */
  propose(input: TradeIntentInput, options?: ProposeOptions): Promise<ProposeResult>;
  /** Block explorer link for a transaction, or null on a chain without an explorer. */
  explorerTxUrl(txHash: `0x${string}`): string | null;
}

/** A Gemini market resolved from its `instrumentSymbol`, with the category the mandate checks. */
export type { ResolvedMarket } from "./markets/gemini";

/**
 * Read-only access to Gemini prediction-market data from `@mandate/gemini` (issue #10). Every method
 * takes an optional abort signal (issue #105): its requests are aborted and never retried when it fires.
 */
export interface MarketsClient {
  /** The venue the markets come from. */
  readonly venue: "gemini";
  /** Active events, optionally limited to Gemini category names and a title search. */
  listEvents(
    options: { categories?: readonly string[]; search?: string },
    signal?: AbortSignal,
  ): Promise<EventSummary[]>;
  getEvent(eventTicker: string, signal?: AbortSignal): Promise<MarketEvent>;
  listLadders(asset: string, signal?: AbortSignal): Promise<LadderListing[]>;
  getLadder(options: GetLadderOptions, signal?: AbortSignal): Promise<Ladder>;
  getSpot(asset: string, signal?: AbortSignal): Promise<SpotPrice>;
  /** The event and contract behind a symbol, or null when Gemini has no such market. */
  resolveMarket(instrumentSymbol: string, signal?: AbortSignal): Promise<ResolvedMarket | null>;
}

/** Turns a holding and a strike ladder into a protection plan, from `@mandate/planner` (issue #10). */
export interface HedgePlanner {
  /** Version of the planning model, recorded with each plan. */
  readonly version: string;
  plan(input: HedgeInput): HedgePlan;
  /** Three to five plain sentences with exact numbers, generated from the plan alone. */
  summarize(plan: HedgePlan): string;
}

/**
 * The console backend: holdings, decision contexts, plans, change requests and pairing
 * (issues #10, #32, #33, #34). Wire shapes are `@mandate/shared` `console-api.ts`. Methods throw
 * `ConsoleClientError`; tools turn it into an `unavailable` verdict.
 */
export interface ConsoleClient {
  /** Base URL of the console backend. */
  readonly baseUrl: string;
  /** The agent every call acts for (`x-mandate-agent`): the console scopes each record to its mandate. */
  readonly agentId: string;
  /** The same console, acting for another agent (docs/accounts.md). */
  forAgent(agentId: string): ConsoleClient;
  getHoldings(signal?: AbortSignal): Promise<HoldingsResponse>;
  putContext(hash: `0x${string}`, document: DecisionContext, signal?: AbortSignal): Promise<ContextResponse>;
  /** The stored document, or null when the console has none under this hash. */
  getContext(hash: `0x${string}`, signal?: AbortSignal): Promise<ContextResponse | null>;
  /**
   * Links an intent to the decision context that explains it (idempotent). A different hash for an
   * intent that already has one throws `conflict`.
   */
  putIntentContext(
    intentId: number,
    request: PutIntentContextRequest,
    signal?: AbortSignal,
  ): Promise<IntentContextResponse>;
  postPlan(request: PostPlanRequest, signal?: AbortSignal): Promise<PlanResponse>;
  postPolicyChangeRequest(
    request: PostPolicyChangeRequest,
    signal?: AbortSignal,
  ): Promise<PolicyChangeRequest>;
  /** Announces the agent (idempotent). */
  putPairing(request: PutPairingRequest, signal?: AbortSignal): Promise<PairingResponse>;
  /** The pairing state, or null when the agent never asked to pair. */
  getPairing(signal?: AbortSignal): Promise<PairingResponse | null>;
  /** Records one signal payment (idempotent on the receipt id). Null when the console has no such route yet (404). */
  putSignalPayment(
    receiptId: string,
    request: PutSignalPaymentRequest,
    signal?: AbortSignal,
  ): Promise<SignalPaymentResponse | null>;
  /** Replaces the signal budget snapshot. Null when the console has no such route yet (404). */
  putSignalBudget(
    request: PutSignalBudgetRequest,
    signal?: AbortSignal,
  ): Promise<SignalBudgetResponse | null>;
  /**
   * What filled positions paid when their markets resolved, newest first, as the executor signed them
   * (issue #92). Null when the console has no such route yet (404).
   */
  getSettlements(signal?: AbortSignal): Promise<SettlementsResponse | null>;
  /**
   * Which Gemini the console reads market data from, from its public `GET /api/health`; production when
   * it names none (a console older than this check).
   */
  getMarketEnvironment(signal?: AbortSignal): Promise<GeminiEnvironment>;
}

/**
 * Pays for signals through the x402 buyer in `src/x402` and enforces the daily tool budget (issue #21).
 * `SignalPayments` in `src/x402/payments.ts` implements it.
 */
export interface PaymentsClient {
  /** Address of the wallet that pays for signals. */
  readonly payer: Address;
  /** Most the signal tool may spend per UTC day, in USDC base units. */
  readonly dailyBudget: bigint;
  /** Most one signal may cost, in USDC base units. */
  readonly maxPrice: bigint;
  /** Today's budget and spend. */
  budget(at: Date): BudgetState;
  /** Buys one hedge signal. Expected refusals (budget, price, seller, Gateway) are outcomes, not errors. */
  buySignal(request: {
    query: HedgeSignalQuery;
    at: Date;
    /** Stops the purchase before the payment is signed; never cuts a payment that may be out. */
    signal?: AbortSignal | undefined;
    /** Called right before the payment is signed. It may throw, and then nothing is paid. */
    beforePayment?: (() => AbortSignal | undefined) | undefined;
  }): Promise<BuySignalOutcome>;
  /**
   * A signal bought earlier, by its receipt id (the payment nonce). Pass it to `planHedge` as
   * `signal: { receiptId, signal }` to let the plan use it.
   */
  purchasedSignal(receiptId: string): SignalPurchase | undefined;
  /** Every signal payment in the durable spend ledger, oldest first: the outbox for console reports. */
  paidSignals(): PaidSignalEntry[];
  /** The buyer's available Circle Gateway balance, in USDC base units. Throws when it cannot be read. */
  gatewayBalance(): Promise<bigint>;
}

export interface Services {
  readonly policy: AgentPolicy | undefined;
  readonly markets: MarketsClient | undefined;
  readonly planner: HedgePlanner | undefined;
  readonly console: ConsoleClient | undefined;
  readonly payments: PaymentsClient | undefined;
  /**
   * Reports signal payments and the signal budget to the console (issue #22). Exists when both the
   * console and payments are configured; `createAppContext` builds it from them.
   */
  readonly paymentReports: PaymentReporter | undefined;
  /** Hedge plans and their execution progress, kept by the server process between sessions. */
  readonly plans: PlanStore;
  /** Recent proposals: replay protection, decision contexts, and documents waiting for the console. */
  readonly ledger: ProposalLedger;
}

/** Builds the services the configuration allows. A missing service is `undefined`, which tools report as `unavailable`. */
export function createServices(config: Config): Services {
  return {
    policy: createAgentPolicy(config),
    markets: createGeminiMarkets({ baseUrl: config.marketData.baseUrl }),
    planner: createHedgePlanner(),
    console: createConsoleClient(config),
    payments: createSignalPayments(config),
    paymentReports: undefined,
    plans: new PlanStore(),
    ledger: new ProposalLedger(),
  };
}
