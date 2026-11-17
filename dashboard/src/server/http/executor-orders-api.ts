import "server-only";

import {
  hashExecutorRecord,
  isFinalVenueOrderState,
  putExecutorVenueRequestSchema,
  putVenueOrderRequestSchema,
  settlementMessage,
  storedVenueOrderSchema,
  VENUE_ORDER_FIXED_FIELDS,
  venueOrderRecordSchema,
  type ExecutorVenue,
  type VenueOrderRecord,
} from "@mandate/shared";
import { type Hex, isAddress, isAddressEqual, recoverMessageAddress } from "viem";

import type { Mandate } from "../accounts/store";
import type { ConsoleService } from "../console-service";
import type { VenueOrderRow } from "../store/venue-orders";
import { apiError, json, readBody } from "./responses";

/**
 * The executor's order journal and venue (issue #93), on the executor API next to settlements: what it
 * placed for each intent, written before the order is sent and updated as it changes, and which venue it
 * fills orders on. Like settlements there is no shared secret: each version is stored only when signed by
 * the contract's `executor()`.
 */

type Handler = (
  request: Request,
  service: ConsoleService,
  params: Record<string, string>,
) => Promise<Response>;

function guarded(name: string, handler: Handler): Handler {
  return async (request, service, params) => {
    try {
      return await handler(request, service, params);
    } catch (error) {
      console.error(`[console] ${request.method} ${new URL(request.url).pathname} failed (${name})`, error);
      return apiError(500, "internal_error", "The console failed to handle this request. Try again.");
    }
  };
}

function intentIdParam(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d{0,15})$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The deployment a GET names with `?chainId=&policy=` (#95: one executor serves every mandate's contract),
 * or the server's own contract when it names none, as an executor from before #95 asks. The journal is
 * keyed by deployment, like settlements.
 */
async function requestedDeployment(request: Request, service: ConsoleService): Promise<string | null> {
  const query = new URL(request.url).searchParams;
  const chainId = query.get("chainId");
  const policy = query.get("policy");
  if (chainId === null && policy === null) {
    return service.deploymentIdFor(service.accounts.store.envMandate());
  }
  if (chainId === null || policy === null || !/^[1-9]\d{0,15}$/.test(chainId) || !isAddress(policy)) {
    return null;
  }
  return (await service.contractOf(Number(chainId), policy))?.chain.deploymentId ?? null;
}

/**
 * Checks that a signed document names a contract this console follows and is signed by that contract's
 * executor. Returns the mandate it belongs to, the deployment id and the signer, or the answer to send.
 */
async function verifySigned(
  service: ConsoleService,
  document: { chainId: number; policy: string },
  hash: Hex,
  signature: Hex,
): Promise<
  | { ok: true; mandate: Mandate; deploymentId: string; signer: `0x${string}` }
  | { ok: false; response: Response }
> {
  const found = isAddress(document.policy)
    ? await service.contractOf(document.chainId, document.policy)
    : null;
  if (!found) {
    return {
      ok: false,
      response: apiError(
        422,
        "wrong_deployment",
        "The record names a chain or Policy contract this console does not follow (or cannot read right now).",
      ),
    };
  }
  const { mandate, chain } = found;
  let signer: `0x${string}`;
  try {
    signer = await recoverMessageAddress({ message: settlementMessage(hash), signature });
  } catch {
    return { ok: false, response: apiError(422, "invalid_signature", "The signature cannot be read.") };
  }
  const roles = chain.roles;
  const deploymentId = chain.deploymentId;
  if (!isAddressEqual(signer, roles.executor)) {
    return {
      ok: false,
      response: apiError(
        403,
        "not_executor",
        "The record is not signed by the contract's executor, the only account that places orders.",
      ),
    };
  }
  return { ok: true, mandate, deploymentId, signer };
}

function storedView(row: VenueOrderRow) {
  return storedVenueOrderSchema.parse({
    intentId: row.intentId,
    hash: row.hash,
    document: row.document,
    signature: row.signature,
    signer: row.signer,
    storedAt: row.storedAt,
  });
}

/** Why `next` may not replace `previous`, or null when it may. */
function replacementProblem(previous: VenueOrderRecord, next: VenueOrderRecord): string | null {
  for (const field of VENUE_ORDER_FIXED_FIELDS) {
    if (previous[field] !== next[field]) return `its ${field} cannot change`;
  }
  if (
    isFinalVenueOrderState(previous.state) &&
    (next.state !== previous.state ||
      next.venueOrderId !== previous.venueOrderId ||
      next.filledHundredths !== previous.filledHundredths ||
      next.filledCents !== previous.filledCents ||
      next.placedAt !== previous.placedAt)
  ) {
    // A closed order keeps its numbers; only its note may change (a settlement problem found later).
    return `the order is already ${previous.state}`;
  }
  if (previous.venueOrderId !== null && next.venueOrderId !== previous.venueOrderId) {
    return "its venue order id cannot change once known";
  }
  if (next.filledHundredths < previous.filledHundredths) return "what filled cannot go down";
  return null;
}

export const getVenueOrder = guarded("get venue order", async (request, service, params) => {
  const intentId = intentIdParam(params.intentId);
  if (intentId === null) {
    return apiError(422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
  }
  const deploymentId = await requestedDeployment(request, service);
  if (!deploymentId) {
    return apiError(
      503,
      "chain_unavailable",
      "The console is not following that Policy contract (or cannot read it right now). Try again shortly.",
    );
  }
  const row = service.venueOrders.order(deploymentId, intentId);
  if (!row) return apiError(404, "not_found", `Intent ${String(intentId)} has no venue order.`);
  return json(storedView(row));
});

export const putVenueOrder = guarded("put venue order", async (request, service, params) => {
  const intentId = intentIdParam(params.intentId);
  if (intentId === null) {
    return apiError(422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
  }
  const body = await readBody(request, putVenueOrderRequestSchema);
  if (!body.ok) return body.response;
  const { document, signature } = body.data;
  if (document.intentId !== intentId) {
    return apiError(422, "intent_mismatch", "The document's intentId must be the intent id in the path.");
  }
  if (document.filledHundredths > document.quantityHundredths) {
    return apiError(422, "invalid_order", "More cannot fill than was ordered.");
  }
  const hash = hashExecutorRecord(document);
  const verified = await verifySigned(service, document, hash, signature);
  if (!verified.ok) return verified.response;

  const intent = service
    .snapshot(verified.mandate)
    .chain?.intents.find((candidate) => candidate.id === intentId);
  if (!intent) {
    return apiError(
      409,
      "not_seen",
      `The console has not seen intent ${String(intentId)} yet. Try again shortly.`,
    );
  }
  if (
    intent.market !== document.market ||
    intent.outcome !== document.outcome ||
    intent.isBuy !== (document.side === "buy") ||
    intent.limitPrice !== document.limitPrice
  ) {
    return apiError(
      422,
      "intent_mismatch",
      `Intent ${String(intentId)} onchain is not an order on this market, outcome, side and limit price.`,
    );
  }

  // From here to the write nothing awaits, so two requests cannot both pass the checks below.
  const existing = service.venueOrders.order(verified.deploymentId, intentId);
  if (existing) {
    if (existing.hash.toLowerCase() === hash.toLowerCase()) return json(storedView(existing), 200);
    const previous = venueOrderRecordSchema.safeParse(existing.document);
    if (previous.success) {
      if (document.revision <= previous.data.revision) {
        return apiError(
          409,
          "stale",
          `The console holds revision ${String(previous.data.revision)} of this order; send a higher one.`,
        );
      }
      const problem = replacementProblem(previous.data, document);
      if (problem)
        return apiError(409, "conflict", `This version cannot replace the stored one: ${problem}.`);
    }
  }
  const row = service.venueOrders.putOrder(verified.deploymentId, {
    intentId,
    revision: document.revision,
    hash,
    document,
    signature: signature.toLowerCase() as Hex,
    signer: verified.signer,
  });
  service.venueChanged(verified.mandate);
  return json(storedView(row), 201);
});

export const putExecutorVenue = guarded("put executor venue", async (request, service) => {
  const body = await readBody(request, putExecutorVenueRequestSchema);
  if (!body.ok) return body.response;
  const { document, signature } = body.data;
  if ((document.venue === "simulated") !== (document.environment === null)) {
    return apiError(
      422,
      "invalid_body",
      "The simulated venue has no environment, and Gemini always has one.",
    );
  }
  const hash = hashExecutorRecord(document);
  const verified = await verifySigned(service, document, hash, signature);
  if (!verified.ok) return verified.response;
  const existing = service.venueOrders.venue(verified.deploymentId);
  const previous = existing ? (existing.document as Partial<ExecutorVenue>) : null;
  if (
    previous?.announcedAt !== undefined &&
    Date.parse(previous.announcedAt) > Date.parse(document.announcedAt)
  ) {
    return apiError(409, "stale", "The console holds a newer announcement from the executor.");
  }
  service.venueOrders.putVenue(verified.deploymentId, {
    hash,
    document,
    signature: signature.toLowerCase() as Hex,
    signer: verified.signer,
  });
  service.venueChanged(verified.mandate);
  return json(
    { venue: document.venue, environment: document.environment, announcedAt: document.announcedAt },
    201,
  );
});
