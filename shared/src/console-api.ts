import { z } from "zod";
import { decisionContextSchema } from "./context";
import { addressSchema, bytes32Schema, policyRulesSchema } from "./types";

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
  /** POST stores a hedge plan the agent produced, so the console can draw it. */
  plans: `${CONSOLE_AGENT_API_BASE}/plans`,
  /** POST files a request to change the rules. */
  policyChangeRequests: `${CONSOLE_AGENT_API_BASE}/policy-change-requests`,
  /** GET: the state of one request. */
  policyChangeRequest: (id: string) => `${CONSOLE_AGENT_API_BASE}/policy-change-requests/${id}`,
  /** PUT announces the agent to the console (idempotent); GET returns the pairing state. */
  pairing: `${CONSOLE_AGENT_API_BASE}/pairing`,
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
