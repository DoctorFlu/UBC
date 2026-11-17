import "server-only";

import type { Hex } from "viem";
import { z } from "zod";

import {
  OWNER_REQUEST_MAX_AGE_MS,
  type OwnerAction,
  ownerAuthSchema,
  ownerRequestMessage,
} from "@/lib/owner-request";

import type { ConsoleService, MandateScope } from "../console-service";
import { type Parsed, apiError, readBody } from "./responses";

/**
 * Reads an owner-signed request: `{ payload, auth: { issuedAt, nonce, signature } }`. The payload must
 * match `payloadSchema`, the signature must recover to the `user()` of the mandate's Policy contract over
 * the message `ownerRequestMessage` builds, the time must be recent and the nonce unused. The session
 * decides which mandate; the signature proves the owner of that mandate's contract approved.
 */
export async function readOwnerRequest<T>(
  request: Request,
  service: ConsoleService,
  mandate: MandateScope,
  action: OwnerAction,
  payloadSchema: z.ZodType<T>,
  now: () => number = Date.now,
): Promise<Parsed<T>> {
  const body = await readBody(request, z.strictObject({ payload: payloadSchema, auth: ownerAuthSchema }));
  if (!body.ok) return body;
  const { payload, auth } = body.data;

  const issued = Date.parse(auth.issuedAt);
  if (Math.abs(now() - issued) > OWNER_REQUEST_MAX_AGE_MS) {
    return fail(401, "stale_signature", "The signature is too old. Sign the request again.");
  }
  if (mandate.deployment === null) {
    return fail(409, "no_contract", "This mandate has no Policy contract yet, so it has no owner to sign.");
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
  const valid = await service.verifyOwnerSignature(chain.roles.user, message, auth.signature as Hex);
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
