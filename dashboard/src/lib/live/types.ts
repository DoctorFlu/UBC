/**
 * The console's live state as the server sends it to the browser: on first render as a prop, then over
 * server-sent events at /api/console/events. Plain JSON only: numbers, strings, booleans and null.
 *
 * Everything onchain is derived by the shared reducer (`@mandate/shared`) from the Policy contract's
 * events; the offchain part comes from the console's own store.
 */
import type {
  ConsoleHolding,
  DecisionContext,
  EventCounts,
  IntentView,
  PolicyChangeRequest,
  PolicyEvent,
  PolicyRules,
  Roles,
  Settlement,
  SettlementVenue,
  VenueEnvironment,
  VenueOrderState,
  WakeStatus,
} from "@mandate/shared";
import type { Address, Hex } from "viem";

import type { AgentPlanView } from "@/lib/hedge/types";
import type { SignalBudgetView, SignalPaymentView } from "@/lib/payments/types";

export type NetworkKind = "local" | "arc-testnet";

/** The chain the console reads and the owner's wallet signs on. */
export interface ConsoleNetwork {
  kind: NetworkKind;
  chainId: number;
  name: string;
  /** RPC the browser may use. Never the server's own RPC URL, which can carry an API key. */
  rpcUrl: string;
  /** Block explorer base URL, or null on the local chain. */
  explorerUrl: string | null;
}

export type FeedSource = "rpc" | "stream";

/**
 * - `starting`: reading history for the first time.
 * - `live`: up to date with the chain.
 * - `lagging`: the primary source is late; data is shown but may be behind.
 * - `offline`: the chain cannot be reached; data, if any, is as of `syncedBlock`.
 * - `unconfigured`: no Policy contract is configured.
 */
export type FeedHealth = "starting" | "live" | "lagging" | "offline" | "unconfigured";

export interface FeedStatus {
  source: FeedSource;
  health: FeedHealth;
  /** One plain sentence saying what the feed is doing and, when unhealthy, what to do. */
  detail: string;
  /** ISO time of the newest event's block, or null before the first event. */
  lastEventAt: string | null;
  /** ISO time the source last confirmed it is current, or null before that. */
  lastSyncAt: string | null;
  /** Newest block the console has fully read. */
  syncedBlock: number | null;
}

export type ContractKind = "production" | "reference";

export interface ContractInfo {
  address: Address;
  deployBlock: number;
  /** Known for the local devchain; null for a deployment configured by address. */
  kind: ContractKind | null;
  /** Read with `user()`, `agent()` and `executor()`: role changes emit no event. Null until first read. */
  roles: Roles | null;
  /** Whether `proposeTrade` can record a decision context hash (requested extension 2). Null until probed. */
  recordsContextHash: boolean | null;
}

/**
 * Where the hash an intent's reason is checked against comes from: its `IntentProposed` event
 * ("onchain"), or the agent's link through the agent API on contracts that record none ("offchain").
 */
export type SealedSource = "onchain" | "offchain";

/**
 * The plan and receipts a stored document names, read without trusting it (`readClaims`). Only used to
 * say which plan's evidence a tampered document breaks; never shown as the agent's reason.
 */
export interface SealedClaims {
  planId: string | null;
  signalReceiptIds: string[];
}

/** The agent's sealed reason for one intent, checked with `verifyContext` against the hash from `source`. */
export type SealedReason =
  | { status: "verified"; source: SealedSource; hash: Hex; document: DecisionContext; storedAt: string }
  | { status: "tampered"; source: SealedSource; hash: Hex; storedAt: string; claims: SealedClaims }
  | { status: "not_stored"; source: SealedSource; hash: Hex };

/**
 * What a filled position paid when its market resolved, as the executor recorded it in the console
 * (issue #92; the contract cannot hold it). `verified`: the document still hashes to the hash it was
 * stored under, and its signature was checked against the contract's `executor()` when it was stored.
 * `tampered`: the stored document no longer matches, so none of its numbers are shown or counted.
 */
export type SettlementView =
  | { status: "verified"; hash: Hex; signer: Address; signature: Hex; storedAt: string; document: Settlement }
  | { status: "tampered"; hash: Hex; storedAt: string };

/**
 * The order the executor placed for an intent on a real venue (issue #93), from its signed journal in the
 * console: only versions that still hash to what was stored are shown. The simulated venue keeps none.
 */
export interface VenueOrderView {
  venue: "gemini";
  environment: VenueEnvironment;
  state: VenueOrderState;
  /** Gemini's order id, once known. */
  venueOrderId: string | null;
  clientOrderId: string;
  quantityHundredths: number;
  filledHundredths: number;
  filledCents: number;
  /** Gemini's fee on the fills, estimated from its schedule (no answer reports it); null until something fills. */
  feeCents: number | null;
  detail: string | null;
  updatedAt: string;
}

/** The venue the executor said it fills orders on when it last started (issue #93). */
export interface ExecutorVenueView {
  venue: SettlementVenue;
  /** Null for the simulated venue. */
  environment: VenueEnvironment | null;
  announcedAt: string;
}

export interface ChainView {
  /** Newest block read, with its timestamp in unix seconds: "today" follows the chain's clock. */
  head: { blockNumber: number; timestamp: number };
  /** Latest rules, or null before the owner's first `setPolicy`. */
  rules: PolicyRules | null;
  paused: boolean;
  committedCents: number;
  lossTodayCents: number;
  realizedPnlCents: number;
  rejectionsByReason: Record<string, number>;
  counts: EventCounts;
  /** Intents in id order, with details read from `getIntent` where no event carried them. */
  intents: IntentView[];
  /** Every Policy event, in chain order. */
  events: PolicyEvent[];
  /** Number of `PolicyUpdated` events: the mandate's version. */
  policyVersion: number;
  /** The `PolicyUpdated` event of the rules in force. */
  policySetBy: { blockNumber: number; timestamp: number; txHash: Hex } | null;
  /** Sealed reasons by intent id, for intents with a context hash onchain or linked offchain. */
  sealed: Record<number, SealedReason>;
  /** Settlements by intent id, for filled positions whose market resolved (issue #92). */
  settlements: Record<number, SettlementView>;
  /** Venue orders by intent id, for intents the executor placed on a real venue (issue #93). */
  venueOrders: Record<number, VenueOrderView>;
  /** The executor's venue, as it last announced it, or null before it has. */
  venue: ExecutorVenueView | null;
}

export interface PairingView {
  agentAddress: Address;
  agentName: string;
  serverVersion: string;
  status: "pending" | "confirmed";
  announcedAt: string;
  confirmedAt: string | null;
  /** True when the Policy contract's `agent()` is this address. */
  isContractAgent: boolean;
}

export interface OffchainView {
  holdings: ConsoleHolding[];
  holdingsUpdatedAt: string | null;
  /** The agent that announced itself most recently. */
  pairing: PairingView | null;
  /** Newest first. */
  changeRequests: PolicyChangeRequest[];
  /**
   * The agent's latest stored plan for each asset, newest first. A stored plan the console cannot read
   * as a `HedgePlan` is left out rather than drawn wrong.
   */
  plans: AgentPlanView[];
  /** The agent's x402 signal payments, newest first (#22). */
  signalPayments: SignalPaymentView[];
  /** The latest signal budget snapshot the agent reported, or null before the first. */
  signalBudget: SignalBudgetView | null;
}

/**
 * Event wake-ups of the Grok Bot routine (issue #40): whether they are on, today's count and the last
 * few. Never the webhook's URL or key.
 */
export interface ConsoleWakeStatus extends WakeStatus {
  /** Why wake-ups are off, in one sentence, or null when they are on. */
  offReason: string | null;
  /** Least time between two price checks while the console runs. */
  priceCheckEveryMs: number;
  /** When the console last checked spot against the current goals, or null before the first check. */
  lastPriceCheckAt: string | null;
  /** Why the last price check could not measure a goal, or null. */
  priceProblem: string | null;
}

export interface ConsoleSnapshot {
  /** Increases with every change, so a client can drop an out-of-date message. */
  seq: number;
  network: ConsoleNetwork;
  feed: FeedStatus;
  /** Null when no Policy contract is configured. */
  contract: ContractInfo | null;
  /** Null until the console has read the chain once. */
  chain: ChainView | null;
  offchain: OffchainView;
  /** Where Grok Bot reaches the MCP server, when configured. */
  mcpPublicUrl: string | null;
  wake: ConsoleWakeStatus;
}
