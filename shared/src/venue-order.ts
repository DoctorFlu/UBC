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

/** What a client order id is made of, besides the intent: the contract and the block it was deployed in. */
export interface OrderIdDeployment {
  chainId: number;
  policy: string;
  /** Hash of the block the contract was deployed in. */
  deployBlockHash: string;
}

/**
 * The longest `client_order_id` Gemini takes. Measured on the sandbox on 2026-11-17: 37 characters are
 * refused with HTTP 400 InvalidInput, "client_order_id must be at most 36 characters"; 36 are accepted and
 * come back intact in the placement's answer, the active orders and the order history.
 */
export const GEMINI_CLIENT_ORDER_ID_MAX = 36;

/** Hex digits of the deployment digest in a client order id: 80 bits. */
const ORDER_ID_DIGEST_DIGITS = 20;

/** `m-` + digest + `-`: what is left of Gemini's 36 characters is the intent id's. */
const ORDER_ID_PREFIX_LENGTH = 2 + ORDER_ID_DIGEST_DIGITS + 1;

/** The largest intent id a client order id can carry: 13 digits. */
export const MAX_ORDER_INTENT_ID = 10 ** (GEMINI_CLIENT_ORDER_ID_MAX - ORDER_ID_PREFIX_LENGTH) - 1;

/** An intent whose id does not fit Gemini's client order id. Thrown before anything is journalled or sent. */
export class ClientOrderIdError extends Error {
  override name = "ClientOrderIdError";
}

/**
 * Our id for an intent's order: `m-<deployment>-<intent id>`, where `<deployment>` is the first 20 hex
 * digits (80 bits) of keccak256 of the chain id, the whole contract address and the whole hash of the
 * block the contract was deployed in. It is the same on every attempt and restart, and at most
 * `GEMINI_CLIENT_ORDER_ID_MAX` (36) characters: 23 for `m-<deployment>-`, which leaves 13 digits for the
 * intent id. An intent above `MAX_ORDER_INTENT_ID` throws `ClientOrderIdError`; at one intent a second,
 * a contract reaches it after 300,000 years.
 *
 * - Two deployments at the same address get different ids (issue #117): a fresh local dev chain deploys
 *   the contract at the address the last one had, but its deploy block has another hash unless both chains
 *   were started and deployed within the same second.
 * - Two contracts never share one (#95): one venue account serves every mandate's contract. The digest
 *   covers the chain, the whole address and the deploy block's hash, which no one knows before the block
 *   is made, so it cannot be ground in advance: matching another contract's digest takes about 2^80
 *   deployments, each paying gas. Among a million honest deployments, the chance that any two share one
 *   is about 1 in 2.4 trillion (n^2 / 2^81).
 * - Nothing in it is meant to be read: the chain and the contract are in the journal's record. The short
 *   `m-` prefix keeps ids of other forms (the owner's own orders, earlier forms) apart from ours.
 *
 * Ids already journalled keep the form they were written in (`mandate-<chain id>-<contract>-...`); a retry
 * reuses its record's id, so nothing is ever looked up under an id it was not sent with.
 */
export function clientOrderIdFor(deployment: OrderIdDeployment, intentId: number): string {
  if (!Number.isSafeInteger(intentId) || intentId < 0 || intentId > MAX_ORDER_INTENT_ID) {
    throw new ClientOrderIdError(
      `intent ${String(intentId)} does not fit Gemini's ${String(GEMINI_CLIENT_ORDER_ID_MAX)}-character client order id (the largest intent id it can carry is ${String(MAX_ORDER_INTENT_ID)})`,
    );
  }
  const policy = deployment.policy.toLowerCase();
  const digest = keccak256(
    stringToBytes(`${String(deployment.chainId)}:${policy}:${deployment.deployBlockHash.toLowerCase()}`),
  ).slice(2, 2 + ORDER_ID_DIGEST_DIGITS);
  return `m-${digest}-${String(intentId)}`;
}

/** Validates a venue order record or announcement and returns keccak256 of its canonical JSON. */
export function hashExecutorRecord(doc: VenueOrderRecord | ExecutorVenue): Hex {
  const valid =
    doc.kind === "venue-order" ? venueOrderRecordSchema.parse(doc) : executorVenueSchema.parse(doc);
  return keccak256(stringToBytes(canonicalJson(valid)));
}
