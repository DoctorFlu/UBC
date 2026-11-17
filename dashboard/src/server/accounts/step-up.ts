import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { AGENT_TOKEN_PREFIX, canonicalJson, policyRulesSchema } from "@mandate/shared";
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";

import { ownerCallSchema } from "@/lib/owner/calls";
import { ownerRequestSchema } from "@/lib/owner-request";

import type { AccountsConfig } from "../config";
import { AccountError, type Access, isPlainText } from "./accounts";
import { hashSecret, newOpaqueId } from "./secrets";
import type { AccountStore } from "./store";

/**
 * Passkey step-up (#95). A session alone never authorises an action that grants power: an owner action on
 * a mandate whose owner key the console holds (a contract it deployed on the demo chain), creating a
 * mandate, and creating an agent token (a credential) on any mandate. The member asks for a challenge
 * bound to the exact action (the mandate, its contract and chain, the function and its arguments, or the
 * agent and the token's name; a nonce; a short expiry), answers it with a passkey of their own with user
 * verification, and only then does the console act. One challenge authorises one action, once. The safe
 * direction stays a session's: pausing (the kill switch, see `needsPasskey`) and revoking a token.
 */

/** A challenge is answered within this, or asked for again. */
export const STEP_UP_TTL_MS = 2 * 60 * 1000;

/** A mandate's name: 1 to 60 printable characters, shown in pages, the agent's answers and passkey prompts. */
export const mandateNameSchema = z
  .string()
  .trim()
  .min(1, "Name the mandate, for example after what it protects.")
  .max(60, "Use at most 60 characters.")
  .refine(isPlainText, "Use letters, digits and punctuation only.");

/** An agent token's name, shown in the Agents list for as long as the token exists. */
export const tokenNameSchema = z
  .string()
  .trim()
  .min(1, "Name the token, for example after the app that will use it.")
  .max(60, "Use at most 60 characters.")
  .refine(isPlainText, "Use letters, digits and punctuation only.")
  // A token pasted into the name would be shown in the Agents list for as long as the token exists.
  .refine(
    (name) => !name.includes(AGENT_TOKEN_PREFIX),
    "That looks like a token. Name it after the app that will use it.",
  );

/** What a step-up authorises. Stored server side with its challenge; never trusted from the answer. */
export const stepUpActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("owner-call"),
    mandateId: z.string().min(1).max(64),
    call: ownerCallSchema,
  }),
  z.strictObject({
    kind: z.literal("owner-request"),
    mandateId: z.string().min(1).max(64),
    request: ownerRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("create-mandate"),
    name: mandateNameSchema,
    /** The first rules, when the console deploys the contract; null when the owner's wallet will. */
    rules: policyRulesSchema.strict().nullable(),
  }),
  z.strictObject({
    kind: z.literal("create-token"),
    agentId: z.string().min(1).max(64),
    name: tokenNameSchema,
  }),
]);
export type StepUpAction = z.infer<typeof stepUpActionSchema>;

/** The answer the browser sends back. */
export const stepUpAnswerSchema = z.strictObject({
  id: z.string().min(1).max(128),
  // SimpleWebAuthn checks its shape; this only bounds it.
  response: z.custom<AuthenticationResponseJSON>(
    (value) => typeof value === "object" && value !== null && JSON.stringify(value).length < 16_384,
  ),
});
export type StepUpAnswer = z.infer<typeof stepUpAnswerSchema>;

/** Where an owner action acts: fixed when the challenge is made, checked again when it is answered. */
export interface StepUpTarget {
  workspaceId: string;
  /** The contract and chain, for actions on a mandate's contract; null for creating a mandate. */
  contract: { chainId: number; address: string } | null;
}

const payloadSchema = z.strictObject({
  memberId: z.string(),
  workspaceId: z.string(),
  contract: z.strictObject({ chainId: z.number(), address: z.string() }).nullable(),
  action: stepUpActionSchema,
  digest: z.string(),
});

/** SHA-256 of the action and where it acts, as the audit trail and the challenge carry it. */
function digestOf(action: StepUpAction, target: StepUpTarget): string {
  // Parsed and lower-cased first, so the same action always has the same digest however it was spelt.
  const contract = target.contract
    ? { chainId: target.contract.chainId, address: target.contract.address.toLowerCase() }
    : null;
  return createHash("sha256")
    .update(
      canonicalJson({ action: stepUpActionSchema.parse(action), contract, workspaceId: target.workspaceId }),
    )
    .digest("hex");
}

export class StepUp {
  constructor(
    private readonly config: AccountsConfig,
    private readonly store: AccountStore,
  ) {}

  /**
   * A challenge for `action`, for the signed-in member's own passkeys. The challenge commits to the
   * action: SHA-256 of a fresh nonce and the action's digest.
   */
  async begin(
    access: Access,
    action: StepUpAction,
    target: StepUpTarget,
  ): Promise<{ id: string; options: PublicKeyCredentialRequestOptionsJSON; digest: string }> {
    if (access.member.role !== "admin") {
      throw new AccountError(403, "forbidden", "Only a workspace admin can act as the owner.");
    }
    const passkeys = this.store.passkeysOf(access.member.id);
    if (passkeys.length === 0) {
      throw new AccountError(409, "no_passkey", "Add a passkey in Setup first: owner actions need one.");
    }
    const digest = digestOf(action, target);
    const challenge = createHash("sha256").update(randomBytes(32)).update(digest).digest();
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: "required",
      timeout: STEP_UP_TTL_MS,
      challenge: new Uint8Array(challenge),
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports,
      })),
    });
    const id = newOpaqueId();
    const payload: z.infer<typeof payloadSchema> = {
      memberId: access.member.id,
      workspaceId: access.workspace.id,
      contract: target.contract,
      action,
      digest,
    };
    this.store.putCeremony(hashSecret(id), "step-up", options.challenge, payload, STEP_UP_TTL_MS);
    return { id, options, digest };
  }

  /**
   * Checks an answer and returns what it authorises, with the passkey that answered. The challenge is
   * used up whatever the outcome. Refused: an unknown, used or expired challenge; another member's or
   * workspace's; a passkey that is not the member's; an answer that does not verify; and an action or
   * target other than `expected` (the request must be for exactly what was authorised).
   */
  async finish(
    access: Access,
    answer: StepUpAnswer,
    expected: { action: StepUpAction; target: StepUpTarget },
  ): Promise<{ action: StepUpAction; credentialId: string; digest: string }> {
    const ceremony = this.store.takeCeremony(hashSecret(answer.id), "step-up");
    const refused = new AccountError(
      401,
      "step_up_refused",
      "That passkey confirmation is not valid for this action. Confirm it again.",
    );
    if (!ceremony) {
      throw new AccountError(
        401,
        "step_up_expired",
        "That passkey confirmation expired or was used. Confirm again.",
      );
    }
    const parsed = payloadSchema.safeParse(ceremony.payload);
    if (!parsed.success) throw refused;
    const payload = parsed.data;
    if (payload.memberId !== access.member.id || payload.workspaceId !== access.workspace.id) throw refused;
    if (payload.digest !== digestOf(expected.action, expected.target)) throw refused;

    const passkey = this.store.passkey(answer.response.id);
    if (!passkey || passkey.memberId !== access.member.id) throw refused;
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: answer.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw refused;
    }
    if (!verified.verified) throw refused;
    this.store.usePasskey(passkey.credentialId, verified.authenticationInfo.newCounter);
    return { action: payload.action, credentialId: passkey.credentialId, digest: payload.digest };
  }
}
