/**
 * Owner-signed requests for the console's offchain writes (holdings, pairing, change requests).
 *
 * The owner is whoever controls the Policy contract's `user()`. Offchain writes the agent relies on
 * therefore carry that owner's approval of exactly what they change, bound to this contract and chain:
 * a wallet signature with a time and a single-use nonce, which the server recovers and accepts only from
 * `user()`; or, for a contract whose owner key the console holds (#95), a member's passkey confirmation
 * of the same action and payload (`server/accounts/step-up.ts`).
 */
import { addressSchema, canonicalJson, holdingSchema } from "@mandate/shared";
import { type Address, type Hex, keccak256, stringToBytes } from "viem";
import { z } from "zod";

export const OWNER_ACTIONS = {
  "holdings.save": "Save the holdings the agent hedges",
  "pairing.confirm": "Confirm the agent that asked to pair",
  "change-request.dismiss": "Dismiss the agent's policy change request",
} as const;

export type OwnerAction = keyof typeof OWNER_ACTIONS;

export const holdingsPayloadSchema = z.strictObject({
  holdings: z
    .array(holdingSchema)
    .max(20)
    .refine((holdings) => new Set(holdings.map((holding) => holding.asset)).size === holdings.length, {
      message: "each asset can appear once",
    }),
});

export const confirmPairingPayloadSchema = z.strictObject({ agentAddress: addressSchema });

export const dismissPayloadSchema = z.strictObject({ id: z.string().min(1).max(64) });

/** Each owner action with its payload, as one value. */
export const ownerRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("holdings.save"), payload: holdingsPayloadSchema }),
  z.strictObject({ action: z.literal("pairing.confirm"), payload: confirmPairingPayloadSchema }),
  z.strictObject({ action: z.literal("change-request.dismiss"), payload: dismissPayloadSchema }),
]);
export type OwnerRequest = z.infer<typeof ownerRequestSchema>;

/** A signature older than this, or this far in the future, is refused. */
export const OWNER_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

export const ownerAuthSchema = z.strictObject({
  issuedAt: z.iso.datetime({ offset: true }),
  nonce: z.string().regex(/^0x[0-9a-f]{32}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export type OwnerAuth = z.infer<typeof ownerAuthSchema>;

export interface OwnerMessageInput {
  action: OwnerAction;
  payload: unknown;
  policyAddress: Address;
  chainId: number;
  issuedAt: string;
  nonce: string;
}

/** The exact text the owner's wallet signs. Readable in the wallet prompt, and unambiguous. */
export function ownerRequestMessage(input: OwnerMessageInput): string {
  const digest: Hex = keccak256(stringToBytes(canonicalJson(input.payload)));
  return [
    `Mandate console: ${OWNER_ACTIONS[input.action]}.`,
    "",
    `Action: ${input.action}`,
    `Policy contract: ${input.policyAddress}`,
    `Chain: ${String(input.chainId)}`,
    `Payload: ${digest}`,
    `Issued at: ${input.issuedAt}`,
    `Nonce: ${input.nonce}`,
  ].join("\n");
}

/** A fresh 16-byte nonce, as lowercase hex. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
