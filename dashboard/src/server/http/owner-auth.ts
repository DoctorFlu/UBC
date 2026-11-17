import "server-only";

import type { Hex } from "viem";
import { z } from "zod";

import {
  OWNER_REQUEST_MAX_AGE_MS,
  type OwnerAction,
  ownerAuthSchema,
  ownerRequestMessage,
  ownerRequestSchema,
} from "@/lib/owner-request";

import { stepUpAnswerSchema } from "../accounts/step-up";
import type { ConsoleService } from "../console-service";
import { type Parsed, apiError, readBody } from "./responses";
import type { ConsoleScope } from "./session";

/**
 * Reads an owner-approved request. The session decides which mandate; the body proves the owner of that
 * mandate's contract approved exactly this payload, in one of two ways:
 *
 * - `{ payload, auth: { issuedAt, nonce, signature } }`: the owner's wallet signed the message
 *   `ownerRequestMessage` builds; the signature must recover to the contract's `user()`, the time must be
 *   recent and the nonce unused. Every mandate whose owner holds their own key.
 * - `{ payload, stepUp }`: a member's passkey confirmed this action and payload on this mandate
 *   (`StepUp`). Only, and always, for a mandate whose owner key the console holds (#95): a session alone
 *   is never the owner's approval.
 */
export async function readOwnerRequest<T>(
  request: Request,
  service: ConsoleService,
  scope: ConsoleScope,
  action: OwnerAction,
  payloadSchema: z.ZodType<T>,
  now: () => number = Date.now,
): Promise<Parsed<T>> {
  const { mandate } = scope;
  const body = await readBody(
    request,
    z.union([
      z.strictObject({ payload: payloadSchema, auth: ownerAuthSchema }),
      z.strictObject({ payload: payloadSchema, stepUp: stepUpAnswerSchema }),
    ]),
  );
  if (!body.ok) return body;
  const { payload } = body.data;

  if (mandate.deployment === null) {
    return fail(409, "no_contract", "This mandate has no Policy contract yet, so it has no owner to sign.");
  }
  if (mandate.deployment === "server") {
    if (!("stepUp" in body.data) || !mandate.contract) {
      return fail(422, "step_up_required", "Confirm this with your passkey.");
    }
    const ownerRequest = ownerRequestSchema.parse({ action, payload });
    await service.stepUp.finish(scope.access, body.data.stepUp, {
      action: { kind: "owner-request", mandateId: mandate.id, request: ownerRequest },
      target: {
        workspaceId: mandate.workspaceId,
        contract: { chainId: mandate.contract.chainId, address: mandate.contract.address },
      },
    });
    return { ok: true, data: payload };
  }
  if (!("auth" in body.data)) {
    return fail(422, "invalid_body", "Sign this request with the owner's wallet.");
  }
  const { auth } = body.data;

  const issued = Date.parse(auth.issuedAt);
  if (Math.abs(now() - issued) > OWNER_REQUEST_MAX_AGE_MS) {
    return fail(401, "stale_signature", "The signature is too old. Sign the request again.");
  }
  const chain = await service.chainFor(mandate);
  if (!chain) {
    return fail(
      503,
      "chain_unavailable",
      "The console can't read the Policy contract right now, so it can't check who the owner is.",
    );
  }
  const message = ownerRequestMessage({
    action,
    payload,
    policyAddress: chain.policy.address,
    chainId: chain.chainId,
    issuedAt: auth.issuedAt,
    nonce: auth.nonce,
  });
  const valid = await service.verifyOwnerSignature(mandate, chain.roles.user, message, auth.signature as Hex);
  if (!valid) {
    return fail(403, "not_owner", "Only the wallet that owns the Policy contract can do this.");
  }
  // Claimed only once the signature checks out, so a failed or unverifiable request can be retried.
  if (!service.claimOwnerNonce(auth.nonce, now)) {
    return fail(401, "replayed_signature", "This signature was already used. Sign the request again.");
  }
  return { ok: true, data: payload };
}

function fail(status: number, code: string, message: string): Parsed<never> {
  return { ok: false, response: apiError(status, code, message) };
}
