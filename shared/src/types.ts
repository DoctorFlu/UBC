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
export const addressSchema = z.custom<Address>((value) => typeof value === "string" && isAddress(value), {
  message: "not a valid address",
});
export const bytes32Schema = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
  {
    message: "not a 32-byte hex string",
  },
);
export const txHashSchema = bytes32Schema;

export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

// ------------------------------------------------------------------ policy

export const policySchema = z.object({
  /** Rule 1: total the agent may deploy. */
  budgetCents: centsSchema,
  /** Rule 2: largest single intent. */
  maxTradeCents: centsSchema,
  /** Rule 3: bitmask of allowed category ids. */
  allowedCategories: centsSchema,
  /** Rule 4: intents above this wait for the owner. 0 means never ask. */
  approvalAboveCents: centsSchema,
  /** Rule 5: realized loss per UTC day that stops new intents. 0 means off. */
  dailyLossCents: centsSchema,
  /** Rule 6: kill switch. */
  paused: z.boolean(),
});
export type Policy = z.infer<typeof policySchema>;

// ------------------------------------------------------------------ intents

/** What the agent proposes. Validated before it is sent so malformed input never reaches the chain. */
export const tradeIntentSchema = z.object({
  market: marketSchema,
  category: categoryIdSchema,
  outcome: outcomeSchema,
  isBuy: z.boolean(),
  amountCents: centsSchema.positive(),
  limitPrice: limitPriceSchema,
  /** keccak256 of the canonical decision context. Zero when there is none. */
  contextHash: bytes32Schema.default(ZERO_HASH),
});
export type TradeIntent = z.infer<typeof tradeIntentSchema>;
export type TradeIntentInput = z.input<typeof tradeIntentSchema>;

export const intentStatusSchema = z.enum(INTENT_STATUSES);

/** An intent as stored by the contract (`getIntent`), with its id. */
export const intentSchema = z.object({
  id: z.int().positive(),
  agent: addressSchema,
  market: z.string(),
  category: anyCategorySchema,
  outcome: z.string(),
  isBuy: z.boolean(),
  amountCents: centsSchema,
  limitPrice: z.int().nonnegative(),
  contextHash: bytes32Schema,
  status: intentStatusSchema,
  /** Reason code when rejected, otherwise null. */
  reason: z.string().nullable(),
  /** Unix seconds of the block that stored the proposal. */
  proposedAt: z.int().nonnegative(),
  /** Set once a result is recorded, otherwise null. */
  filledCents: centsSchema.nullable(),
  pnlCents: signedCentsSchema.nullable(),
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

export const policyEventSchema = z.discriminatedUnion("type", [
  eventMetaSchema.extend({
    type: z.literal("IntentProposed"),
    intentId: z.int().positive(),
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
    intentId: z.int().positive(),
    market: z.string(),
    outcome: z.string(),
    isBuy: z.boolean(),
    amountCents: centsSchema,
    limitPrice: z.int().nonnegative(),
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentRejected"),
    intentId: z.int().positive(),
    reason: z.string(),
  }),
  eventMetaSchema.extend({
    type: z.literal("IntentNeedsApproval"),
    intentId: z.int().positive(),
    amountCents: centsSchema,
  }),
  eventMetaSchema.extend({
    type: z.literal("ResultRecorded"),
    intentId: z.int().positive(),
    filled: z.boolean(),
    filledCents: centsSchema,
    pnlCents: signedCentsSchema,
  }),
  eventMetaSchema.extend({
    type: z.literal("PolicySet"),
    policy: policySchema,
  }),
  eventMetaSchema.extend({
    type: z.literal("PausedSet"),
    paused: z.boolean(),
  }),
]);
export type PolicyEvent = z.infer<typeof policyEventSchema>;
export type PolicyEventType = PolicyEvent["type"];
export type PolicyEventOf<T extends PolicyEventType> = Extract<PolicyEvent, { type: T }>;
