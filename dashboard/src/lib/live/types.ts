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
} from "@mandate/shared";
import type { Address, Hex } from "viem";

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

/** The agent's sealed reason for one intent, checked against the hash the contract recorded. */
export type SealedReason =
  | { status: "verified"; hash: Hex; document: DecisionContext; storedAt: string }
  | { status: "tampered"; hash: Hex; storedAt: string }
  | { status: "not_stored"; hash: Hex };

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
  /** Sealed reasons by intent id, for intents whose proposal recorded a non-zero context hash. */
  sealed: Record<number, SealedReason>;
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
  latestPlan: { planId: string; asset: string; storedAt: string } | null;
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
}
