import { z } from "zod";
import { decisionContextSchema } from "./context";
import { SETTLEMENT_VENUES, settlementSchema, signatureSchema } from "./settlement";
import {
  executorVenueSchema,
  FILL_SOURCES,
  VENUE_ENVIRONMENTS,
  VENUE_ORDER_STATES,
  venueOrderRecordSchema,
} from "./venue-order";
import { addressSchema, bytes32Schema, intentIdSchema, policyRulesSchema, txHashSchema } from "./types";

/**
 * Wire contract between the agent's MCP server and the console backend.
 *
 * The console is the system of record for everything that is not onchain: the owner's holdings,
 * decision-context documents, hedge plans, policy change requests and agent pairing. The MCP server
 * is the only caller. The console implements these routes; the MCP server calls them through a
 * client built on the same schemas, so both sides fail loudly on any drift.
 *
 * Rules for every route:
 * - Base path `CONSOLE_AGENT_API_BASE`, JSON in and out.
 * - `Authorization: Bearer <CONSOLE_SERVICE_TOKEN>`, compared in constant time. Missing or wrong: 401.
 * - Every route but `resolveToken` acts for one agent, named in the `x-mandate-agent` header
 *   (`AGENT_ID_HEADER` in `tenancy.ts`), and reads and writes only that agent's mandate. Missing: 400;
 *   unknown: 404.
 * - A body or parameter that fails its schema: 422 with `consoleErrorSchema`.
 * - Nothing here can change the onchain policy, approve an intent or unpause. Those need the
 *   owner's wallet.
 */
export const CONSOLE_AGENT_API_BASE = "/api/agent/v1";

export const CONSOLE_AGENT_ROUTES = {
  /** GET: the holdings the owner entered. */
  holdings: `${CONSOLE_AGENT_API_BASE}/holdings`,
  /** PUT stores a decision context under its hash; GET returns it. */
  context: (hash: string) => `${CONSOLE_AGENT_API_BASE}/contexts/${hash}`,
  /**
   * PUT links an intent to its decision-context hash (idempotent; a different hash is 409 `conflict`);
   * GET returns the link. For contracts that record no `contextHash` onchain.
   */
  intentContext: (intentId: number | string) =>
    `${CONSOLE_AGENT_API_BASE}/intents/${String(intentId)}/context`,
  /** POST stores a hedge plan the agent produced, so the console can draw it. */
  plans: `${CONSOLE_AGENT_API_BASE}/plans`,
  /** POST files a request to change the rules. */
  policyChangeRequests: `${CONSOLE_AGENT_API_BASE}/policy-change-requests`,
  /** GET: the state of one request. */
  policyChangeRequest: (id: string) => `${CONSOLE_AGENT_API_BASE}/policy-change-requests/${id}`,
  /** PUT announces the agent to the console (idempotent); GET returns the pairing state. */
  pairing: `${CONSOLE_AGENT_API_BASE}/pairing`,
  /**
   * PUT records one x402 payment for a signal under its receipt id (idempotent: the first write wins).
   * Issue #22.
   */
  signalPayment: (receiptId: string) => `${CONSOLE_AGENT_API_BASE}/signal-payments/${receiptId}`,
  /** PUT replaces the snapshot of the agent's signal budget and Gateway balance (latest `asOf` wins). Issue #22. */
  signalBudget: `${CONSOLE_AGENT_API_BASE}/signal-budget`,
  /** POST: which agent and mandate a bearer token belongs to (`tenancy.ts`). Needs no agent header. Issue #94. */
  resolveToken: `${CONSOLE_AGENT_API_BASE}/auth/resolve`,
  /** POST: the console signs a transaction with the agent's key, or refuses (`tenancy.ts`). Issue #94. */
  signTransaction: `${CONSOLE_AGENT_API_BASE}/signer/transactions`,
  /** GET: the settlements the executor recorded for the agent's mandate, newest first. Issue #92. */
  settlements: `${CONSOLE_AGENT_API_BASE}/settlements`,
  /**
   * GET: the orders the executor placed on a real venue for the agent's mandate, from its signed journal:
   * how many contracts each order was for, and how much filled. Issue #117.
   */
  orders: `${CONSOLE_AGENT_API_BASE}/orders`,
  /**
   * GET: what the owner sees in the console that the agent reads nowhere else: the console's public
   * address for links, the agent's change requests still waiting for the owner, and the cover held now
   * against each current goal. Issue #97.
   */
  summary: `${CONSOLE_AGENT_API_BASE}/summary`,
} as const;

/**
 * The executor's side of the console (issue #92). The executor records what each filled position paid
 * at settlement here, because the Policy contract can record one result per intent and the executor
 * spends it on the fill. There is no shared secret: each record is signed with the executor key, and
 * the console stores it only when the signer is the contract's `executor()`.
 */
export const CONSOLE_EXECUTOR_API_BASE = "/api/executor/v1";

export const CONSOLE_EXECUTOR_ROUTES = {
  /**
   * PUT stores one settlement under its intent id. The first record wins: the same document again is 200,
   * a different one is 409 `conflict`.
   */
  settlement: (intentId: number | string) => `${CONSOLE_EXECUTOR_API_BASE}/settlements/${String(intentId)}`,
  /**
   * The executor's journal of the order it placed for an intent (issue #93). GET returns the latest
   * version (404 when there is none). PUT stores a new version: 201 when stored, 200 when the console
   * already holds this exact version, 409 `stale` for an older revision and 409 `conflict` for a change
   * the record does not allow (another market or quantity, or anything after it closed).
   */
  order: (intentId: number | string) => `${CONSOLE_EXECUTOR_API_BASE}/orders/${String(intentId)}`,
  /** PUT announces the venue the executor fills orders on (issue #93). The latest announcement wins. */
  venue: `${CONSOLE_EXECUTOR_API_BASE}/venue`,
  /**
   * GET lists the contracts whose `executor()` is the signer (#95: one executor serves every mandate's
   * contract), with `?chainId=&issuedAt=&signature=`: the signature is the executor key's over
   * `executorContractsMessage`, at most `EXECUTOR_CONTRACTS_MAX_AGE_MS` old.
   */
  contracts: `${CONSOLE_EXECUTOR_API_BASE}/contracts`,
} as const;

const isoDateTime = z.iso.datetime({ offset: true });

/** A signed listing request older than this, or this far in the future, is refused. */
export const EXECUTOR_CONTRACTS_MAX_AGE_MS = 5 * 60 * 1000;

/** What the executor key signs (EIP-191) to ask which contracts it serves on a chain. */
export function executorContractsMessage(input: { chainId: number; issuedAt: string }): string {
  return [
    "Mandate executor: list the contracts I serve.",
    `Chain: ${String(input.chainId)}`,
    `Issued at: ${input.issuedAt}`,
  ].join("\n");
}

/** One contract the executor serves: where it is, and the block to read its events from. */
export const executorContractSchema = z.strictObject({
  chainId: z.int().positive(),
  policy: z.string().regex(/^0x[0-9a-f]{40}$/),
  deployBlock: z.int().nonnegative(),
});
export type ExecutorContract = z.infer<typeof executorContractSchema>;

export const executorContractsResponseSchema = z.strictObject({
  contracts: z.array(executorContractSchema).max(10_000),
});

export const consoleErrorSchema = z.strictObject({
  error: z.strictObject({
    /** Stable machine-readable code, for example `unauthorized`, `invalid_body`, `hash_mismatch`, `not_found`. */
    code: z.string().min(1),
    /** One plain sentence a person can act on. */
    message: z.string().min(1),
  }),
});
export type ConsoleError = z.infer<typeof consoleErrorSchema>;

// Holdings

/** A decimal quantity as a string with up to 8 decimal places, for example "0.05". Never a float. */
export const holdingQuantitySchema = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/, {
  message: "quantity must be a plain decimal with at most 8 decimal places",
});

export const holdingSchema = z.strictObject({
  /** Asset symbol in upper case, as Gemini spells it: BTC, ETH, SOL. */
  asset: z.string().regex(/^[A-Z0-9]{2,10}$/),
  quantity: holdingQuantitySchema,
  /** Optional note from the owner, shown to the agent as context. */
  note: z.string().max(280).optional(),
});
export type ConsoleHolding = z.infer<typeof holdingSchema>;

export const holdingsResponseSchema = z.strictObject({
  holdings: z.array(holdingSchema),
  /** When the owner last saved the holdings, or null when none were ever saved. */
  updatedAt: isoDateTime.nullable(),
});
export type HoldingsResponse = z.infer<typeof holdingsResponseSchema>;

// Decision contexts

/** PUT body. The console recomputes the hash and refuses a document that does not match the path (422 `hash_mismatch`). */
export const putContextRequestSchema = z.strictObject({ document: decisionContextSchema });
export type PutContextRequest = z.infer<typeof putContextRequestSchema>;

export const contextResponseSchema = z.strictObject({
  hash: bytes32Schema,
  document: decisionContextSchema,
  storedAt: isoDateTime,
});
export type ContextResponse = z.infer<typeof contextResponseSchema>;

// Intent to decision-context links

/**
 * PUT body. On a contract without `IntentProposed` (the production contract) no `contextHash` is onchain,
 * so the agent tells the console which context explains which intent: the hash it stored with PUT
 * contexts, and the transaction that proposed the intent. The console checks the document against this
 * hash with `verifyContext` and shows it as recorded offchain. Repeating the same link is a no-op; a
 * different hash for an intent that already has one is refused with 409 `conflict`.
 */
export const putIntentContextRequestSchema = z.strictObject({
  hash: bytes32Schema,
  txHash: txHashSchema,
});
export type PutIntentContextRequest = z.infer<typeof putIntentContextRequestSchema>;

export const intentContextResponseSchema = z.strictObject({
  intentId: intentIdSchema,
  hash: bytes32Schema,
  txHash: txHashSchema,
  linkedAt: isoDateTime,
});
export type IntentContextResponse = z.infer<typeof intentContextResponseSchema>;

// Hedge plans

/**
 * POST body. `plan` is the `HedgePlan` object from `@mandate/planner`, kept opaque here so this
 * package does not depend on the planner; the console validates it with the planner's own types.
 * Posting the same `planId` again replaces nothing and returns the stored record.
 */
export const postPlanRequestSchema = z.strictObject({
  planId: z.string().min(1).max(128),
  asset: holdingSchema.shape.asset,
  /** The owner's request that led to this plan, in their words. */
  requestText: z.string().max(2000),
  createdAt: isoDateTime,
  plan: z.record(z.string(), z.unknown()),
});
export type PostPlanRequest = z.infer<typeof postPlanRequestSchema>;

export const planResponseSchema = z.strictObject({ planId: z.string().min(1), storedAt: isoDateTime });
export type PlanResponse = z.infer<typeof planResponseSchema>;

// Policy change requests

/** The rules an agent may ask to change. `paused` is absent on purpose: only the owner pauses and unpauses. */
export const proposedRulesSchema = policyRulesSchema.omit({ paused: true }).partial();
export type ProposedRules = z.infer<typeof proposedRulesSchema>;

export const postPolicyChangeRequestSchema = z.strictObject({
  agentAddress: addressSchema,
  /** Only the fields the agent wants changed. At least one. */
  proposed: proposedRulesSchema.refine((rules) => Object.keys(rules).length > 0, {
    message: "propose at least one rule change",
  }),
  /** Why the agent is asking, shown to the owner next to the diff. */
  reason: z.string().trim().min(1).max(1000),
});
export type PostPolicyChangeRequest = z.infer<typeof postPolicyChangeRequestSchema>;

export const POLICY_CHANGE_REQUEST_STATUSES = ["pending", "applied", "dismissed"] as const;

export const policyChangeRequestSchema = z.strictObject({
  id: z.string().min(1),
  agentAddress: addressSchema,
  proposed: proposedRulesSchema,
  reason: z.string(),
  status: z.enum(POLICY_CHANGE_REQUEST_STATUSES),
  createdAt: isoDateTime,
  /** When the owner applied or dismissed it, or null while pending. */
  resolvedAt: isoDateTime.nullable(),
  /** The owner's `setPolicy` transaction when applied, otherwise null. */
  appliedTxHash: bytes32Schema.nullable(),
});
export type PolicyChangeRequest = z.infer<typeof policyChangeRequestSchema>;

// Pairing

export const putPairingRequestSchema = z.strictObject({
  agentAddress: addressSchema,
  /** How the agent introduces itself in the console, for example "Grok Bot". */
  agentName: z.string().trim().min(1).max(60),
  serverVersion: z.string().min(1).max(40),
});
export type PutPairingRequest = z.infer<typeof putPairingRequestSchema>;

export const PAIRING_STATUSES = ["pending", "confirmed"] as const;

export const pairingResponseSchema = z.strictObject({
  agentAddress: addressSchema,
  agentName: z.string(),
  /** `confirmed` once the owner has claimed this agent in the console. */
  status: z.enum(PAIRING_STATUSES),
  /** Console page where the owner confirms the agent. Safe to show in chat; it contains no secret. */
  claimUrl: z.url(),
  /** True when the Policy contract's `agent()` equals `agentAddress`. */
  isContractAgent: z.boolean(),
});
export type PairingResponse = z.infer<typeof pairingResponseSchema>;

// Signal payments (x402, issue #22)
//
// The MCP server pays the signal API per request from the agent's Circle Gateway balance and keeps the
// truth in its spend ledger. It reports two things here, best effort:
// - each payment, once, under its receipt id (`signalPayment`), resent until the console answers 2xx;
// - a snapshot of the budget (`signalBudget`), sent when the server starts and after each purchase.
// They are separate because a payment is an immutable fact while the budget is state that changes
// without a payment (a new UTC day, a restart with other settings, a Gateway deposit). Both routes
// answer 404 until the console implements them; the server treats that as "not recorded yet".

/**
 * A USDC amount in atomic units (6 decimals) as a plain decimal string, for example "1000" for
 * 0.001 USDC. Never a float and never a formatted amount.
 */
export const usdcAtomicSchema = z.string().regex(/^(0|[1-9]\d{0,29})$/, {
  message: "amount must be a whole number of USDC atomic units (6 decimals) as a decimal string",
});

/** What a payment bought: the hedge signal, as the seller served it. */
export const paidSignalSchema = z.strictObject({
  /** keccak256 of the signal document (its `signalId`). */
  signalId: bytes32Schema,
  asset: z.string().min(1).max(10),
  eventTicker: z.string().min(1).max(40),
  /** Ladder kind, for example `weekly`. */
  horizon: z.string().min(1).max(20),
  /** When the ladder settles. */
  expiry: isoDateTime,
  /** When the seller computed the signal. */
  asOf: isoDateTime,
  /** Strikes per verdict. */
  counts: z.strictObject({
    cheap: z.int().nonnegative(),
    fair: z.int().nonnegative(),
    expensive: z.int().nonnegative(),
    noOffer: z.int().nonnegative(),
  }),
});
export type PaidSignal = z.infer<typeof paidSignalSchema>;

/**
 * PUT body for one x402 payment the agent made for a signal, keyed in the path by its receipt id
 * (the 32-byte nonce of the payment authorization, which Gateway's transfer history is searchable by).
 * Payments are immutable facts: the first write wins, and repeating a receipt id stores nothing new.
 * It carries no key and no payment signature.
 */
export const putSignalPaymentRequestSchema = z.strictObject({
  /** USDC paid, in atomic units. */
  amount: usdcAtomicSchema,
  /** When the paid response arrived. */
  paidAt: isoDateTime,
  /** Path and query of the paid resource on the signal API, for example `/v1/signal/hedge?asset=BTC&horizon=weekly`. */
  resource: z.string().startsWith("/").max(500),
  /** CAIP-2 network of the payment, for example `eip155:5042002` (Arc testnet). */
  network: z.string().min(1).max(64),
  /** The agent's buyer wallet. */
  payer: addressSchema,
  /** The seller's address, or null when the server no longer has the receipt. */
  payee: addressSchema.nullable(),
  /** Circle Gateway settlement reference from the seller's answer (not an onchain hash), or null when none was given. */
  settlementId: z.string().min(1).max(500).nullable(),
  /** What was bought, or null when the seller's answer was not a valid signal (the payment still happened). */
  signal: paidSignalSchema.nullable(),
});
export type PutSignalPaymentRequest = z.infer<typeof putSignalPaymentRequestSchema>;

export const signalPaymentResponseSchema = z.strictObject({
  receiptId: bytes32Schema,
  /** When the console first recorded it. */
  recordedAt: isoDateTime,
});
export type SignalPaymentResponse = z.infer<typeof signalPaymentResponseSchema>;

/**
 * PUT body: the signal budget as the MCP server enforces it right now. A whole replacement; the
 * console keeps the snapshot with the latest `asOf` and ignores an older one. The server sends it when
 * it starts and after every purchase, so the console is right after a restart even when the owner
 * changed the budget settings, and before the first purchase of the day.
 * After `resetsAt` the snapshot's `spentToday` no longer applies: show 0 of `dailyBudget` spent until
 * the next snapshot arrives.
 */
export const putSignalBudgetRequestSchema = z.strictObject({
  /** The wallet whose Circle Gateway balance pays for signals. */
  buyerAddress: addressSchema,
  /** UTC day the numbers are for, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Most the agent may spend on signals per UTC day, in USDC atomic units. */
  dailyBudget: usdcAtomicSchema,
  /** Counted against today's budget: paid, plus payments whose outcome is unknown. Atomic units. */
  spentToday: usdcAtomicSchema,
  /** Most the agent pays for one signal, in USDC atomic units. */
  maxPricePerPurchase: usdcAtomicSchema,
  /** When the next day's budget starts (00:00 UTC). */
  resetsAt: isoDateTime,
  /** Available Circle Gateway balance of the buyer, in atomic units, or null when it could not be read. */
  gatewayBalance: usdcAtomicSchema.nullable(),
  /** When the server took this snapshot. */
  asOf: isoDateTime,
});
export type PutSignalBudgetRequest = z.infer<typeof putSignalBudgetRequestSchema>;

/** The snapshot the console now holds (the request's or a newer one), with when it stored it. */
export const signalBudgetResponseSchema = putSignalBudgetRequestSchema.extend({ storedAt: isoDateTime });
export type SignalBudgetResponse = z.infer<typeof signalBudgetResponseSchema>;

// Settlements (#92)

/** PUT body: the settlement document and the executor's EIP-191 signature of `hashSettlement(document)`. */
export const putSettlementRequestSchema = z.strictObject({
  document: settlementSchema,
  signature: signatureSchema,
});
export type PutSettlementRequest = z.infer<typeof putSettlementRequestSchema>;

/** One stored settlement, as the console holds it. */
export const storedSettlementSchema = z.strictObject({
  intentId: intentIdSchema,
  hash: bytes32Schema,
  document: settlementSchema,
  signature: signatureSchema,
  /** The executor address the signature recovers to. */
  signer: addressSchema,
  storedAt: isoDateTime,
});
export type StoredSettlement = z.infer<typeof storedSettlementSchema>;

export const settlementsResponseSchema = z.strictObject({
  /** Newest settlement first. Only records whose hash still matches their document. */
  settlements: z.array(storedSettlementSchema),
});
export type SettlementsResponse = z.infer<typeof settlementsResponseSchema>;

/**
 * One order the executor placed on a venue, as the agent API serves it (issue #117): the latest version of
 * its journal record that still verifies, without the venue's or our order ids.
 */
export const agentOrderSchema = z.strictObject({
  intentId: intentIdSchema,
  venue: z.literal("gemini"),
  environment: z.enum(VENUE_ENVIRONMENTS),
  state: z.enum(VENUE_ORDER_STATES),
  /**
   * Contracts the order was placed for, in hundredths: the most whose cost at the limit plus Gemini's fee
   * fit the approved amount, so it can be fewer than the amount buys at the limit alone.
   */
  quantityHundredths: z.int().positive(),
  filledHundredths: z.int().nonnegative(),
  filledCents: z.int().nonnegative(),
  /** Gemini's fee on the fills, estimated from its schedule; null until something fills. */
  feeCents: z.int().nonnegative().nullable(),
});
export type AgentOrder = z.infer<typeof agentOrderSchema>;

export const ordersResponseSchema = z.strictObject({
  /** By intent id. Intents filled by the simulated venue have none. */
  orders: z.array(agentOrderSchema),
  /**
   * The venue the executor last announced for the agent's contract, or null before it has: with the
   * orders, where each fill came from (`fillSourceOf`). Absent from a console older than this field.
   */
  venue: z
    .strictObject({ venue: z.enum(SETTLEMENT_VENUES), environment: z.enum(VENUE_ENVIRONMENTS).nullable() })
    .nullable()
    .optional(),
  /**
   * Where each filled intent's fill came from, as the console labels it: by the announcement in force when
   * its result was mined, never by a later one. Prefer this to `venue`, which is only the venue now.
   * Absent from a console older than this field.
   */
  fillSources: z.array(z.strictObject({ intentId: intentIdSchema, source: z.enum(FILL_SOURCES) })).optional(),
});
export type OrdersResponse = z.infer<typeof ordersResponseSchema>;

// The owner's view (#97)

/**
 * `unavailable`: the console could not measure it now (Gemini's quotes did not answer, or the planner
 * refused the holding). The other states are the planner's (`docs/cover.md`).
 */
export const COVER_NOW_STATES = ["met", "partly_met", "not_met", "nothing_to_cover", "unavailable"] as const;

/** The cover held now against one current goal: the agent's latest plan for an asset, not expired yet. */
export const coverNowSchema = z.strictObject({
  asset: z.string().min(1),
  eventTicker: z.string().min(1),
  /** When the goal's ladder expires. */
  expiresAt: isoDateTime,
  /** The plan that set the goal. */
  planId: z.string().min(1),
  floorCents: z.int().nullable(),
  state: z.enum(COVER_NOW_STATES),
  /** Spot the cover was measured from, or null when `unavailable`. */
  spotCents: z.int().nullable(),
  /** Cover is what the positions pay if the price ends below this. Null when there is nothing to cover. */
  measuredBelowCents: z.int().nullable(),
  /** What the goal calls for there. Null when `unavailable`. */
  targetPayoutCents: z.int().nullable(),
  /** What the positions held on the ladder (filled, waiting to fill, waiting for the owner) pay there. */
  heldPayoutCents: z.int().nullable(),
  /**
   * `heldPayoutCents` split by how far each position has come: filled, approved and waiting to fill, and
   * waiting for the owner's approval. Null when `unavailable`.
   */
  heldByState: z
    .strictObject({ filledCents: z.int(), awaitingFillCents: z.int(), awaitingOwnerCents: z.int() })
    .nullable(),
  /** held / target in basis points (10000 is 100%), or null. */
  coverBps: z.int().nullable(),
  /** What a new plan would add below the floor: the shortfall, or 0 when met. */
  missingPayoutCents: z.int().nullable(),
});
export type CoverNowView = z.infer<typeof coverNowSchema>;

export const summaryResponseSchema = z.strictObject({
  /**
   * The mandate's pages on the console (`<console>/m/<mandate id>`, #95): links for the owner are built on
   * it (`/approvals`, `/hedge`), so each opens the mandate this agent acts for.
   */
  consoleUrl: z.url(),
  /** The agent's change requests still waiting for the owner, newest first. */
  changeRequests: z.array(policyChangeRequestSchema),
  /** One entry per current goal, at most one per asset. Empty when the agent has no current goal. */
  cover: z.array(coverNowSchema),
  asOf: isoDateTime,
});
export type SummaryResponse = z.infer<typeof summaryResponseSchema>;

// Venue orders and the executor's venue (#93)

/** PUT body: one version of an intent's venue order record, signed with the executor key. */
export const putVenueOrderRequestSchema = z.strictObject({
  document: venueOrderRecordSchema,
  signature: signatureSchema,
});
export type PutVenueOrderRequest = z.infer<typeof putVenueOrderRequestSchema>;

/** The version the console holds. */
export const storedVenueOrderSchema = z.strictObject({
  intentId: intentIdSchema,
  hash: bytes32Schema,
  document: venueOrderRecordSchema,
  signature: signatureSchema,
  signer: addressSchema,
  storedAt: isoDateTime,
});
export type StoredVenueOrder = z.infer<typeof storedVenueOrderSchema>;

/** PUT body: the executor's announcement of its venue, signed with the executor key. */
export const putExecutorVenueRequestSchema = z.strictObject({
  document: executorVenueSchema,
  signature: signatureSchema,
});
export type PutExecutorVenueRequest = z.infer<typeof putExecutorVenueRequestSchema>;
