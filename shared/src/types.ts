import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { MAX_LIMIT_PRICE, MIN_LIMIT_PRICE } from "./units";
import { Category } from "./categories";
import { INTENT_STATUSES } from "./reasons";

// ------------------------------------------------------------------ primitives

/** Non-negative integer cents within the safe integer range. */
export const centsSchema = z.int().nonnegative();
/** Signed integer cents, for profit and loss. */
export const signedCentsSchema = z.int();
export const limitPriceSchema = z.int().min(MIN_LIMIT_PRICE).max(MAX_LIMIT_PRICE);
/** A category this version knows (0 to 6). Proposals must use one of these. */
export const categoryIdSchema = z.int().min(0).max(Category.Other);
/** Any value the contract can store in its `uint8 category`. */
export const anyCategorySchema = z.int().min(0).max(255);
export const outcomeSchema = z.enum(["YES", "NO"]);
export type Outcome = z.infer<typeof outcomeSchema>;
/** Gemini's `instrumentSymbol`, for example `GEMI-BTC2611202200-HI65000`. */
export const marketSchema = z.string().trim().min(1).max(128);
/** Intent ids are array indexes in the contract: the first intent is 0. */
export const intentIdSchema = z.int().nonnegative();
export const addressSchema = z.custom<Address>((value) => typeof value === "string" && isAddress(value), {
  message: "not a valid address",
});
export const bytes32Schema = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
  { message: "not a 32-byte hex string" },
);
export const txHashSchema = bytes32Schema;

export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

// ------------------------------------------------------------------ rules

/** The contract's `PolicyRules` struct (the spec calls it `Policy`). */
export const policyRulesSchema = z.object({
  /** Rule 1: total the agent may deploy on buys. */
  budgetCents: centsSchema,
  /** Rule 2: largest single order. */
  maxTradeCents: centsSchema,
  /** Rule 3: bitmask of allowed category ids. */
  allowedCategories: centsSchema,
  /** Rule 4: orders above this wait for the user. 0 means never ask. */
  approvalAboveCents: centsSchema,
  /** Rule 5: realized loss per UTC day that stops new intents. 0 means off. */
  dailyLossCents: centsSchema,
  /** Rule 6: kill switch. */
  paused: z.boolean(),
});
export type PolicyRules = z.infer<typeof policyRulesSchema>;

// ------------------------------------------------------------------ intents

/**
 * What the agent proposes. Validated before it is sent. Offchain conventions (price 1 to 99, YES or NO) are
 * stricter than the contract; a zero amount is allowed because the contract answers it with a verdict
 * ("zero amount") rather than an error.
 */
export const tradeIntentSchema = z.object({
  market: marketSchema,
  category: categoryIdSchema,
  outcome: outcomeSchema,
  isBuy: z.boolean(),
  amountCents: centsSchema,
  limitPrice: limitPriceSchema,
  /** keccak256 of the canonical decision context. Zero when there is none. Needs requested extension 2. */
  contextHash: bytes32Schema.default(ZERO_HASH),
});
export type TradeIntent = z.infer<typeof tradeIntentSchema>;
export type TradeIntentInput = z.input<typeof tradeIntentSchema>;

export const intentStatusSchema = z.enum(INTENT_STATUSES);

/** An intent as the contract stores it (`getIntent`), with its id. Field order follows the struct. */
export const intentSchema = z.object({
  id: intentIdSchema,
  market: z.string(),
  category: anyCategorySchema,
  outcome: z.string(),
  isBuy: z.boolean(),
  amountCents: centsSchema,
  limitPrice: z.int().nonnegative(),
  status: intentStatusSchema,
  /** Unix seconds of the block that stored the proposal. */
  proposedAt: z.int().nonnegative(),
  /** 0 until a result is recorded, and 0 for a failed order. */
  filledCents: centsSchema,
  pnlCents: signedCentsSchema,
});
export type Intent = z.infer<typeof intentSchema>;

// ------------------------------------------------------------------ events

export const eventMetaSchema = z.object({
  blockNumber: z.int().nonnegative(),
  /** Unix seconds of the block. */
  blockTimestamp: z.int().nonnegative(),
  transactionHash: txHashSchema,
  logIndex: z.int().nonnegative(),
});
export type EventMeta = z.infer<typeof eventMetaSchema>;

/** Decoded Policy events. `IntentProposed` is requested extension 1; the rest are in the production contract. */
export const policyEventSchema = z.discriminatedUnion("type", [
  eventMetaSchema.extend({
    type: z.literal("PolicyUpdated"),
    rules: policyRulesSchema,
  }),
  eventMetaSchema.extend({
    type: z.literal("Paused"),
    paused: z.boolean(),
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentProposed"),
    intentId: intentIdSchema,
    agent: addressSchema,
    market: z.string(),
    category: anyCategorySchema,
    outcome: z.string(),
    isBuy: z.boolean(),
    amountCents: centsSchema,
    limitPrice: z.int().nonnegative(),
    contextHash: bytes32Schema,
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentApproved"),
    intentId: intentIdSchema,
    market: z.string(),
    outcome: z.string(),
    isBuy: z.boolean(),
    amountCents: centsSchema,
    limitPrice: z.int().nonnegative(),
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentRejected"),
    intentId: intentIdSchema,
    reason: z.string(),
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentNeedsApproval"),
    intentId: intentIdSchema,
    amountCents: centsSchema,
  }),
  eventMetaSchema.extend({
    type: z.literal("ResultRecorded"),
    intentId: intentIdSchema,
    filled: z.boolean(),
    /** The amount actually used: 0 whenever `filled` is false. */
    filledCents: centsSchema,
    pnlCents: signedCentsSchema,
  }),
]);
export type PolicyEvent = z.infer<typeof policyEventSchema>;
export type PolicyEventType = PolicyEvent["type"];
export type PolicyEventOf<T extends PolicyEventType> = Extract<PolicyEvent, { type: T }>;
