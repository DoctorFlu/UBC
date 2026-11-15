import "server-only";

import {
  bytes32Schema,
  contextResponseSchema,
  decisionContextSchema,
  hashContext,
  holdingsResponseSchema,
  intentContextResponseSchema,
  pairingResponseSchema,
  planResponseSchema,
  policyChangeRequestSchema,
  postPlanRequestSchema,
  postPolicyChangeRequestSchema,
  putContextRequestSchema,
  putIntentContextRequestSchema,
  putPairingRequestSchema,
  verifyContext,
} from "@mandate/shared";
import { type Address, type Hex, isAddressEqual } from "viem";

import type { ConsoleService } from "../console-service";
import type { StoredPairing } from "../store/offchain";
import { hedgePlanSchema } from "./plan-schema";
import { apiError, checkServiceToken, describeIssues, json, readBody } from "./responses";

/**
 * The console side of the agent API in `@mandate/shared/console-api`. Every handler validates its input
 * and its output with the shared schemas, so the MCP server and the console fail loudly on any drift.
 * Nothing here touches the chain: the agent can store records and ask, never set rules or approve.
 */
export type AgentHandler = (
  request: Request,
  service: ConsoleService,
  params: Record<string, string>,
) => Promise<Response>;

/** Wraps a handler with the service token check and a uniform 500 for anything unexpected. */
export function agentRoute(handler: AgentHandler) {
  return async (
    request: Request,
    service: ConsoleService,
    params: Record<string, string> = {},
  ): Promise<Response> => {
    const denied = checkServiceToken(request, service.config.serviceToken);
    if (denied) return denied;
    try {
      return await handler(request, service, params);
    } catch (error) {
      console.error(`[console] ${request.method} ${new URL(request.url).pathname} failed`, error);
      return apiError(500, "internal_error", "The console failed to handle this request. Try again.");
    }
  };
}

// ------------------------------------------------------------------ holdings

export const getHoldings = agentRoute((_request, service) => {
  const stored = service.offchain.holdings();
  return Promise.resolve(
    json(holdingsResponseSchema.parse({ holdings: stored.holdings, updatedAt: stored.updatedAt })),
  );
});

// ------------------------------------------------------------------ decision contexts

function parseHash(params: Record<string, string>): Hex | Response {
  const parsed = bytes32Schema.safeParse(params.hash);
  if (!parsed.success) {
    return apiError(422, "invalid_parameter", "The context hash must be a 0x-prefixed 32-byte hex string.");
  }
  return parsed.data.toLowerCase() as Hex;
}

export const putContext = agentRoute(async (request, service, params) => {
  const hash = parseHash(params);
  if (hash instanceof Response) return hash;
  const body = await readBody(request, putContextRequestSchema);
  if (!body.ok) return body.response;
  const computed = hashContext(body.data.document);
  if (computed.toLowerCase() !== hash) {
    return apiError(
      422,
      "hash_mismatch",
      `The document hashes to ${computed}, not to the hash in the path. Hash it with hashContext from @mandate/shared.`,
    );
  }
  const { context, created } = service.offchain.putContext(hash, body.data.document);
  service.changed();
  return contextResponse(context.hash, context.document, context.storedAt, created ? 201 : 200);
});

export const getContext = agentRoute((_request, service, params) => {
  const hash = parseHash(params);
  if (hash instanceof Response) return Promise.resolve(hash);
  const context = service.offchain.context(hash);
  if (!context)
    return Promise.resolve(apiError(404, "not_found", `No decision context is stored under ${hash}.`));
  return Promise.resolve(contextResponse(context.hash, context.document, context.storedAt, 200));
});

function contextResponse(hash: Hex, document: unknown, storedAt: string, status: number): Response {
  const parsed = decisionContextSchema.safeParse(document);
  if (!parsed.success || !verifyContext(parsed.data, hash)) {
    return apiError(
      409,
      "tampered",
      "The stored document no longer matches its hash, so the console will not serve it.",
    );
  }
  return json(contextResponseSchema.parse({ hash, document: parsed.data, storedAt }), status);
}

// ------------------------------------------------------------------ hedge plans

export const postPlan = agentRoute(async (request, service) => {
  const body = await readBody(request, postPlanRequestSchema);
  if (!body.ok) return body.response;
  const plan = hedgePlanSchema.safeParse(body.data.plan);
  if (!plan.success) {
    return apiError(
      422,
      "invalid_plan",
      `The plan is not a HedgePlan from @mandate/planner: ${describeIssues(plan.error)}`,
    );
  }
  if (plan.data.planId !== body.data.planId || plan.data.asset !== body.data.asset) {
    return apiError(422, "plan_mismatch", "planId and asset must match the plan's own planId and asset.");
  }
  const { plan: stored, created } = service.offchain.putPlan(body.data);
  service.changed();
  return json(
    planResponseSchema.parse({ planId: stored.planId, storedAt: stored.storedAt }),
    created ? 201 : 200,
  );
});

// ------------------------------------------------------------------ policy change requests

export const postPolicyChangeRequest = agentRoute(async (request, service) => {
  const body = await readBody(request, postPolicyChangeRequestSchema);
  if (!body.ok) return body.response;
  const created = service.offchain.createChangeRequest(body.data);
  service.changed();
  return json(policyChangeRequestSchema.parse(created), 201);
});

export const getPolicyChangeRequest = agentRoute((_request, service, params) => {
  const found = service.offchain.changeRequest(params.id ?? "");
  if (!found) {
    return Promise.resolve(
      apiError(404, "not_found", `No policy change request has the id "${params.id ?? ""}".`),
    );
  }
  return Promise.resolve(json(policyChangeRequestSchema.parse(found)));
});

// ------------------------------------------------------------------ intent to context links

function intentIdParam(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d{0,15})$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Links an intent to the decision context that explains it, for contracts that record no
 * `contextHash` onchain. Links belong to the live deployment, so a reset chain starts with none.
 */
export const putIntentContext = agentRoute(async (request, service, params) => {
  const intentId = intentIdParam(params.intentId);
  if (intentId === null) {
    return apiError(422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
  }
  const body = await readBody(request, putIntentContextRequestSchema);
  if (!body.ok) return body.response;
  const deploymentId = service.deploymentId;
  if (!deploymentId) {
    return apiError(
      503,
      "chain_unavailable",
      "The console is not following a Policy contract yet. Try again shortly.",
    );
  }
  const result = service.offchain.linkIntentContext(deploymentId, intentId, body.data.hash, body.data.txHash);
  if (!result.ok) {
    return apiError(
      409,
      "conflict",
      `Intent ${String(intentId)} is already linked to context ${result.existing.hash} from transaction ${result.existing.txHash}.`,
    );
  }
  if (result.created) service.changed();
  return json(intentContextResponseSchema.parse(result.link), result.created ? 201 : 200);
});

export const getIntentContext = agentRoute((_request, service, params) => {
  const intentId = intentIdParam(params.intentId);
  if (intentId === null) {
    return Promise.resolve(
      apiError(422, "invalid_parameter", "The intent id must be a whole number, starting at 0."),
    );
  }
  const deploymentId = service.deploymentId;
  const link = deploymentId ? service.offchain.intentContextLink(deploymentId, intentId) : null;
  if (!link) {
    return Promise.resolve(
      apiError(404, "not_found", `Intent ${String(intentId)} has no linked decision context.`),
    );
  }
  return Promise.resolve(json(intentContextResponseSchema.parse(link)));
});

// ------------------------------------------------------------------ pairing

export const putPairing = agentRoute(async (request, service) => {
  const body = await readBody(request, putPairingRequestSchema);
  if (!body.ok) return body.response;
  const pairing = service.offchain.announce(body.data);
  service.changed();
  return json(await pairingResponse(service, pairing));
});

export const getPairing = agentRoute(async (_request, service) => {
  const pairing = service.offchain.latestPairing();
  if (!pairing) {
    return apiError(404, "not_found", "No agent has announced itself yet. PUT the pairing first.");
  }
  return json(await pairingResponse(service, pairing));
});

/** The owner's page for confirming an agent. */
export function claimUrl(service: ConsoleService, agentAddress: Address): string {
  return `${service.config.publicUrl}/setup/pair/${agentAddress}`;
}

async function pairingResponse(service: ConsoleService, pairing: StoredPairing) {
  const roles = await service.currentRoles();
  return pairingResponseSchema.parse({
    agentAddress: pairing.agentAddress,
    agentName: pairing.agentName,
    status: pairing.status,
    claimUrl: claimUrl(service, pairing.agentAddress),
    isContractAgent: roles ? isAddressEqual(roles.agent, pairing.agentAddress) : false,
  });
}
