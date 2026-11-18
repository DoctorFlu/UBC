import "server-only";

import { parsePolicyLogs, rulesFromChain, txHashSchema, UnitError } from "@mandate/shared";
import { z } from "zod";

import {
  confirmPairingPayloadSchema,
  dismissPayloadSchema,
  holdingsPayloadSchema,
} from "@/lib/owner-request";

import { readOwnerRequest } from "./owner-auth";
import { apiError, json, readBody } from "./responses";
import { consoleRoute } from "./session";

/**
 * Routes the owner's browser calls for offchain changes. Each one needs a session, and names its
 * mandate. The owner approves each: signed by that mandate's Policy contract `user()` wallet, or, where
 * the console holds the owner key, confirmed with a member's passkey (`readOwnerRequest`). Marking a
 * change request applied is proven by the owner's own `setPolicy` transaction instead.
 */

export const saveHoldings = consoleRoute(async (request, service, scope) => {
  const { mandate } = scope;
  const parsed = await readOwnerRequest(request, service, scope, "holdings.save", holdingsPayloadSchema);
  if (!parsed.ok) return parsed.response;
  const saved = service.offchain.saveHoldings(mandate.id, parsed.data.holdings);
  service.changed(mandate.id);
  return json(saved);
});

export const confirmPairing = consoleRoute(async (request, service, scope) => {
  const { mandate } = scope;
  const parsed = await readOwnerRequest(
    request,
    service,
    scope,
    "pairing.confirm",
    confirmPairingPayloadSchema,
  );
  if (!parsed.ok) return parsed.response;
  const chain = await service.chainFor(mandate, { trusted: true });
  if (!chain)
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  const pairing = service.offchain.confirmPairing(mandate.id, parsed.data.agentAddress, chain.roles.user);
  if (!pairing) {
    return apiError(404, "not_found", "That agent has not asked to pair with this console.");
  }
  service.changed(mandate.id);
  return json(pairing);
});

export const dismissChangeRequest = consoleRoute(async (request, service, scope, params) => {
  const { mandate } = scope;
  const id = params.id ?? "";
  const parsed = await readOwnerRequest(
    request,
    service,
    scope,
    "change-request.dismiss",
    dismissPayloadSchema,
  );
  if (!parsed.ok) return parsed.response;
  if (parsed.data.id !== id) return apiError(422, "invalid_body", "The signed id does not match the path.");
  const updated = service.offchain.resolveChangeRequest(mandate.id, parsed.data.id, { status: "dismissed" });
  if (!updated) return apiError(404, "not_found", "No change request has that id.");
  service.changed(mandate.id);
  return json(updated);
});

/**
 * Closes a change request as applied once the owner's `setPolicy` transaction is onchain. The server
 * checks the receipt itself: a successful transaction in which the mandate's Policy contract emitted a
 * `PolicyUpdated` event carrying every value the agent asked for. Only the contract's `user()` at that
 * moment can make it emit one, so the event is the proof: it holds for a smart-account owner (whose
 * transaction is to its own account) and for an owner who has since handed the role on with `setUser`.
 */
export const markChangeRequestApplied = consoleRoute(async (request, service, scope, params) => {
  const { mandate } = scope;
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
  if (receipt.status !== "success") {
    return apiError(422, "not_applied", "That transaction did not succeed.");
  }
  // Only the rules event matters here; any other log of the contract the console cannot read is
  // reported in Audit by the console's reader.
  const updated = parsePolicyLogs(receipt.logs, {
    address: client.address,
    onUndecodable: () => undefined,
  }).find((log) => log.eventName === "PolicyUpdated");
  if (!updated) return apiError(422, "not_applied", "That transaction did not change this mandate's rules.");
  let rules;
  try {
    rules = rulesFromChain(updated.args);
  } catch (error) {
    if (!(error instanceof UnitError)) throw error;
    return apiError(422, "not_applied", "The new rules hold values too large for the console to compare.");
  }
  const mismatched = Object.entries(existing.proposed).filter(
    ([key, value]) => rules[key as keyof typeof rules] !== value,
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
  service.changed(mandate.id);
  return json(resolved);
});
