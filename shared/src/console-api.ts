import { z } from "zod";
import { decisionContextSchema } from "./context";
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
} as const;

const isoDateTime = z.iso.datetime({ offset: true });

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
