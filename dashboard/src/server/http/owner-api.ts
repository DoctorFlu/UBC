import "server-only";

import { addressSchema, decodePolicyLogs, holdingSchema, txHashSchema } from "@mandate/shared";
import { isAddressEqual } from "viem";
import { z } from "zod";

import { readOwnerRequest } from "./owner-auth";
import { apiError, json, readBody } from "./responses";
import { consoleRoute } from "./session";

/**
 * Routes the owner's browser calls for offchain changes. Each one needs a session, which picks the
 * mandate, and is signed by that mandate's Policy contract `user()` wallet (see lib/owner-request.ts),
 * except marking a change request applied, which is proven by the owner's own `setPolicy` transaction.
 */

export const holdingsPayloadSchema = z.strictObject({
  holdings: z
    .array(holdingSchema)
    .max(20)
    .refine((holdings) => new Set(holdings.map((holding) => holding.asset)).size === holdings.length, {
      message: "each asset can appear once",
    }),
});

export const saveHoldings = consoleRoute(async (request, service, { mandate }) => {
  const parsed = await readOwnerRequest(request, service, mandate, "holdings.save", holdingsPayloadSchema);
  if (!parsed.ok) return parsed.response;
  const saved = service.offchain.saveHoldings(mandate.id, parsed.data.holdings);
  service.changed();
  return json(saved);
});

export const confirmPairingPayloadSchema = z.strictObject({ agentAddress: addressSchema });

export const confirmPairing = consoleRoute(async (request, service, { mandate }) => {
  const parsed = await readOwnerRequest(
    request,
    service,
    mandate,
    "pairing.confirm",
    confirmPairingPayloadSchema,
  );
  if (!parsed.ok) return parsed.response;
  const chain = await service.chainFor(mandate);
  if (!chain)
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  const pairing = service.offchain.confirmPairing(mandate.id, parsed.data.agentAddress, chain.roles.user);
  if (!pairing) {
    return apiError(404, "not_found", "That agent has not asked to pair with this console.");
  }
  service.changed();
  return json(pairing);
});

export const dismissPayloadSchema = z.strictObject({ id: z.string().min(1) });

export const dismissChangeRequest = consoleRoute(async (request, service, { mandate }, params) => {
  const id = params.id ?? "";
  const parsed = await readOwnerRequest(
    request,
    service,
    mandate,
    "change-request.dismiss",
    dismissPayloadSchema,
  );
  if (!parsed.ok) return parsed.response;
  if (parsed.data.id !== id) return apiError(422, "invalid_body", "The signed id does not match the path.");
  const updated = service.offchain.resolveChangeRequest(mandate.id, parsed.data.id, { status: "dismissed" });
  if (!updated) return apiError(404, "not_found", "No change request has that id.");
  service.changed();
  return json(updated);
});

/**
 * Closes a change request as applied once the owner's `setPolicy` transaction is onchain. The server
 * checks the receipt itself: a successful transaction from `user()` to the mandate's Policy contract whose
 * `PolicyUpdated` event carries every value the agent asked for.
 */
export const markChangeRequestApplied = consoleRoute(async (request, service, { mandate }, params) => {
  const id = params.id ?? "";
  const body = await readBody(request, z.strictObject({ txHash: txHashSchema }));
  if (!body.ok) return body.response;
  const existing = service.offchain.changeRequest(mandate.id, id);
  if (!existing) return apiError(404, "not_found", "No change request has that id.");
  if (existing.status !== "pending") return json(existing);

  if (mandate.deployment === null) {
    return apiError(409, "no_contract", "This mandate has no Policy contract yet.");
  }
  const chain = await service.chainFor(mandate);
  if (!chain) {
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  }
  const client = chain.policy;
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
    !isAddressEqual(receipt.from, chain.roles.user)
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
  const resolved = service.offchain.resolveChangeRequest(mandate.id, id, {
    status: "applied",
    txHash: receipt.transactionHash,
  });
  service.changed();
  return json(resolved);
});
