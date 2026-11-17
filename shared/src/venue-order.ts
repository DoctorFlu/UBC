import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { MAX_MARKET_SYMBOL_LENGTH, isMarketSymbol } from "./anomalies";
import { canonicalJson } from "./context";
import { SETTLEMENT_VENUES } from "./settlement";
import { addressSchema, intentIdSchema, outcomeSchema } from "./types";

/**
 * Venue orders (issue #93): the executor's journal of the order it placed for each approved intent, kept
 * in the console because the executor has no disk of its own and the contract holds only the final fill.
 *
 * The record is written before the order is sent and updated as it changes, so a restarted executor
 * knows an order may already exist and looks it up instead of sending it again. Like a settlement, each
 * version is signed with the executor key (EIP-191 over the 32-byte hash of its canonical JSON), and the
 * console stores it only when the signer is the contract's `executor()`. `revision` only goes up, so an
 * old version sent again cannot replace a newer one.
 */

const isoDateTime = z.iso.datetime({ offset: true });

/** Where a real venue trades: Gemini's sandbox (test funds) or production (real money). */
export const VENUE_ENVIRONMENTS = ["sandbox", "production"] as const;
export type VenueEnvironment = (typeof VENUE_ENVIRONMENTS)[number];

/**
 * - `placing`: written just before the order is sent; the order may or may not exist yet.
 * - `not_placed`: Gemini refused the request for a reason that is not the order's (the key, the terms, the
 *   account, the rate limit). No order exists; the executor may send it again later.
 * - `unknown`: no answer came. The order may exist; the executor looks it up and never sends it again.
 * - `open`: Gemini holds the order; it may still fill.
 * - `filled`, `partly_filled` (closed with part of it filled), `cancelled` (closed with nothing filled),
 *   `rejected` (Gemini refused the order itself): final.
 */
export const VENUE_ORDER_STATES = [
  "placing",
  "not_placed",
  "unknown",
  "open",
  "filled",
  "partly_filled",
  "cancelled",
  "rejected",
] as const;
export type VenueOrderState = (typeof VENUE_ORDER_STATES)[number];

const FINAL_STATES: ReadonlySet<VenueOrderState> = new Set([
  "filled",
  "partly_filled",
  "cancelled",
  "rejected",
]);

/** True when the order will not change again. */
export function isFinalVenueOrderState(state: VenueOrderState): boolean {
  return FINAL_STATES.has(state);
}

const lowerAddress = addressSchema.refine((value) => value === value.toLowerCase(), "must be lower case");

export const venueOrderRecordSchema = z.strictObject({
  kind: z.literal("venue-order"),
  version: z.literal(1),
  chainId: z.int().positive(),
  policy: lowerAddress,
  intentId: intentIdSchema,
  /** Goes up by at least one with every new version of the record. */
  revision: z.int().min(1),
  venue: z.literal("gemini"),
  environment: z.enum(VENUE_ENVIRONMENTS),
  /** Our id for the order, the same on every attempt: see `clientOrderIdFor`. */
  clientOrderId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  market: z.string().max(MAX_MARKET_SYMBOL_LENGTH).refine(isMarketSymbol, "not a Gemini symbol"),
  side: z.enum(["buy", "sell"]),
  outcome: outcomeSchema,
  /** Contracts ordered, in hundredths. */
  quantityHundredths: z.int().positive(),
  /** Cents per $1 contract. */
  limitPrice: z.int().min(1).max(99),
  state: z.enum(VENUE_ORDER_STATES),
  /** Gemini's order id, once known. */
  venueOrderId: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable(),
  /** Contracts filled so far, in hundredths. */
  filledHundredths: z.int().nonnegative(),
  /** What the fills cost, in cents (rounded up). */
  filledCents: z.int().nonnegative(),
  /**
   * Gemini's fee on the fills so far, estimated from its published schedule at the taker rate (see
   * `estimatedFeeCents` in @mandate/gemini), because no answer reports it. Absent until something fills,
   * and on records written before the executor estimated fees.
   */
  feeCents: z.int().nonnegative().optional(),
  /** One plain sentence: why it closed, why it was refused, what the executor is waiting for. */
  detail: z.string().max(500).nullable(),
  /** When this attempt was sent. */
  placedAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type VenueOrderRecord = z.infer<typeof venueOrderRecordSchema>;

/** The fields that never change across versions of one intent's record. */
export const VENUE_ORDER_FIXED_FIELDS = [
  "chainId",
  "policy",
  "intentId",
  "venue",
  "environment",
  "clientOrderId",
  "market",
  "side",
  "outcome",
  "quantityHundredths",
  "limitPrice",
] as const satisfies readonly (keyof VenueOrderRecord)[];

/** What the executor announces about itself when it starts: which venue fills the contract's orders. */
export const executorVenueSchema = z.strictObject({
  kind: z.literal("executor-venue"),
  version: z.literal(1),
  chainId: z.int().positive(),
  policy: lowerAddress,
  venue: z.enum(SETTLEMENT_VENUES),
  /** Null for the simulated venue, which trades nowhere. */
  environment: z.enum(VENUE_ENVIRONMENTS).nullable(),
  announcedAt: isoDateTime,
});
export type ExecutorVenue = z.infer<typeof executorVenueSchema>;

/**
 * Our id for an intent's order: 24 hex digits (96 bits) of keccak256 of the chain and the contract, then
 * the intent id. It is the same on every attempt and restart, and differs between contracts. One venue
 * account serves every mandate's contract (#95), so ids of two contracts must never meet: a prefix of the
 * address alone could, since anyone deploying a contract on Arc can grind an address to match another's
 * first digits; 96 bits of a hash cannot be ground to. At most 49 characters.
 *
 * An order journaled before this form keeps the id it was placed with (`gemini-venue.ts`).
 */
export function clientOrderIdFor(chainId: number, policy: string, intentId: number): string {
  const contract = keccak256(stringToBytes(`${String(chainId)}:${policy.toLowerCase()}`)).slice(2, 26);
  return `mandate-${contract}-${String(intentId)}`;
}

/** Validates a venue order record or announcement and returns keccak256 of its canonical JSON. */
export function hashExecutorRecord(doc: VenueOrderRecord | ExecutorVenue): Hex {
  const valid =
    doc.kind === "venue-order" ? venueOrderRecordSchema.parse(doc) : executorVenueSchema.parse(doc);
  return keccak256(stringToBytes(canonicalJson(valid)));
}
