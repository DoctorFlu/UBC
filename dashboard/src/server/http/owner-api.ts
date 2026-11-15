import "server-only";

import { addressSchema, decodePolicyLogs, holdingSchema, txHashSchema } from "@mandate/shared";
import { isAddressEqual } from "viem";
import { z } from "zod";

import type { ConsoleService } from "../console-service";
import { readOwnerRequest } from "./owner-auth";
import { apiError, json, readBody } from "./responses";

/**
 * Routes the owner's browser calls for offchain changes. Each one is signed by the Policy contract's
 * `user()` wallet (see lib/owner-request.ts), except marking a change request applied, which is proven by
 * the owner's own `setPolicy` transaction instead.
 */

export const holdingsPayloadSchema = z.strictObject({
  holdings: z
    .array(holdingSchema)
    .max(20)
    .refine((holdings) => new Set(holdings.map((holding) => holding.asset)).size === holdings.length, {
      message: "each asset can appear once",
    }),
});

export async function saveHoldings(request: Request, service: ConsoleService): Promise<Response> {
  const parsed = await readOwnerRequest(request, service, "holdings.save", holdingsPayloadSchema);
  if (!parsed.ok) return parsed.response;
  const saved = service.offchain.saveHoldings(parsed.data.holdings);
  service.changed();
  return json(saved);
}

export const confirmPairingPayloadSchema = z.strictObject({ agentAddress: addressSchema });

export async function confirmPairing(request: Request, service: ConsoleService): Promise<Response> {
  const parsed = await readOwnerRequest(request, service, "pairing.confirm", confirmPairingPayloadSchema);
  if (!parsed.ok) return parsed.response;
  const roles = await service.currentRoles();
  if (!roles)
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  const pairing = service.offchain.confirmPairing(parsed.data.agentAddress, roles.user);
  if (!pairing) {
    return apiError(404, "not_found", "That agent has not asked to pair with this console.");
  }
  service.changed();
  return json(pairing);
}

export const dismissPayloadSchema = z.strictObject({ id: z.string().min(1) });

export async function dismissChangeRequest(
  request: Request,
  service: ConsoleService,
  id: string,
): Promise<Response> {
  const parsed = await readOwnerRequest(request, service, "change-request.dismiss", dismissPayloadSchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.data.id !== id) return apiError(422, "invalid_body", "The signed id does not match the path.");
  const updated = service.offchain.resolveChangeRequest(parsed.data.id, { status: "dismissed" });
  if (!updated) return apiError(404, "not_found", "No change request has that id.");
  service.changed();
  return json(updated);
}

/**
 * Closes a change request as applied once the owner's `setPolicy` transaction is onchain. The server
 * checks the receipt itself: a successful transaction from `user()` to the Policy contract whose
 * `PolicyUpdated` event carries every value the agent asked for.
 */
export async function markChangeRequestApplied(
  request: Request,
  service: ConsoleService,
  id: string,
): Promise<Response> {
  const body = await readBody(request, z.strictObject({ txHash: txHashSchema }));
  if (!body.ok) return body.response;
  const existing = service.offchain.changeRequest(id);
  if (!existing) return apiError(404, "not_found", "No change request has that id.");
  if (existing.status !== "pending") return json(existing);

  const client = service.policyClient;
  const roles = await service.currentRoles();
  if (!client || !roles) {
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  }
  let receipt;
  try {
    receipt = await client.publicClient.getTransactionReceipt({ hash: body.data.txHash });
  } catch {
    return apiError(422, "unknown_transaction", "That transaction is not onchain yet.");
  }
  if (
    receipt.status !== "success" ||
    !receipt.to ||
    !isAddressEqual(receipt.to, client.address) ||
    !isAddressEqual(receipt.from, roles.user)
  ) {
    return apiError(422, "not_applied", "That transaction is not a successful setPolicy from the owner.");
  }
  const updated = decodePolicyLogs(
    receipt.logs.map((log) => ({ ...log, blockTimestamp: 0n })),
    { address: client.address },
  ).find((event) => event.type === "PolicyUpdated");
  if (!updated) return apiError(422, "not_applied", "That transaction did not change the rules.");
  const mismatched = Object.entries(existing.proposed).filter(
    ([key, value]) => updated.rules[key as keyof typeof updated.rules] !== value,
  );
  if (mismatched.length > 0) {
    return apiError(
      422,
      "not_applied",
      `The new rules differ from the request in ${mismatched.map(([key]) => key).join(", ")}.`,
    );
  }
  const resolved = service.offchain.resolveChangeRequest(id, {
    status: "applied",
    txHash: receipt.transactionHash,
  });
  service.changed();
  return json(resolved);
}
