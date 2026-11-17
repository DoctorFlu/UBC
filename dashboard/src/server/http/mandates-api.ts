import "server-only";

import { policyRulesSchema, txHashSchema } from "@mandate/shared";
import { z } from "zod";

import type {
  CreatedMandateResponse,
  MandateView,
  MandatesResponse,
  WalletDeployView,
} from "@/lib/accounts/types";
import { needsPasskey, ownerCallSchema } from "@/lib/owner/calls";

import { clientKey } from "../accounts/rate-limit";
import {
  type StepUpAction,
  type StepUpTarget,
  mandateNameSchema,
  stepUpActionSchema,
  stepUpAnswerSchema,
} from "../accounts/step-up";
import type { Mandate } from "../accounts/store";
import type { ConsoleService } from "../console-service";
import { DeployError } from "../mandates/deployer";
import { apiError, json, readBody } from "./responses";
import { type ConsoleScope, WORKSPACE, consoleRoute } from "./session";

/**
 * Several mandates per workspace (#95): listing and creating them, deploying their contracts, the passkey
 * step-up for owner actions, and the owner calls the console signs for a contract it deployed.
 */

export function mandateView(service: ConsoleService, mandate: Mandate): MandateView {
  const agent = service.accounts.store.agentOf(mandate.id);
  const contract = mandate.contract
    ? { chainId: mandate.contract.chainId, address: mandate.contract.address }
    : mandate.deployment === "env"
      ? (() => {
          const session = service.serverContract;
          return session
            ? { chainId: session.deployment.chain.id, address: session.deployment.address }
            : null;
        })()
      : null;
  return {
    id: mandate.id,
    name: mandate.name,
    deployment: mandate.deployment,
    contract,
    ownerSigner: mandate.deployment === null ? null : mandate.deployment === "server" ? "console" : "wallet",
    agent: { id: agent.id, address: agent.address },
    createdAt: mandate.createdAt,
  };
}

function adminOnly(scope: ConsoleScope): Response | null {
  return scope.access.member.role === "admin"
    ? null
    : apiError(403, "forbidden", "Only a workspace admin can do this.");
}

function limited(seconds: number, what: string): Response {
  const response = apiError(429, "rate_limited", `${what} Try again in ${String(seconds)} s.`);
  response.headers.set("Retry-After", String(seconds));
  return response;
}

/** GET /api/console/mandates: the workspace's mandates, oldest first. */
export const listMandates = consoleRoute((_request, service, { access }) => {
  const body: MandatesResponse = {
    deployer: service.mandates.deployer(),
    limit: service.config.mandates.maxPerWorkspace,
    mandates: service.accounts.store
      .mandates(access.workspace.id)
      .map((mandate) => mandateView(service, mandate)),
  };
  return json(body);
}, WORKSPACE);

const createSchema = z.strictObject({
  name: mandateNameSchema,
  /** The first rules, for a contract the console deploys (the owner's wallet sets its own). */
  rules: policyRulesSchema.strict().nullable(),
  stepUp: stepUpAnswerSchema.nullable(),
});

/**
 * POST /api/console/mandates: a new mandate, its agent and the agent's first token (in this answer only).
 * A passkey confirms the name and the first rules, as one prompt: the token is a credential, and on the
 * demo chain the console deploys the contract with those rules. On Arc the owner's wallet deploys it next
 * and sets the rules itself (`deployment` below), so `rules` is null there.
 */
export const createMandate = consoleRoute(async (request, service, scope) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const body = await readBody(request, createSchema);
  if (!body.ok) return body.response;
  const deployer = service.mandates.deployer();
  if (deployer === null) {
    return apiError(
      503,
      "chain_unavailable",
      "The console can't read the chain right now. Try again shortly.",
    );
  }
  const wait = service.accounts.limits.mandateCreation.take(
    `${scope.access.member.id}:${clientKey(request, service.config.accounts.trustProxy)}`,
  );
  if (wait > 0) return limited(wait, "Too many new mandates.");
  const { name, rules, stepUp } = body.data;
  if (deployer === "server" && rules === null) {
    return apiError(422, "invalid_body", "Set the new mandate's first rules.");
  }
  if (deployer === "wallet" && rules !== null) {
    return apiError(
      422,
      "invalid_body",
      "Your wallet sets this mandate's rules once it has deployed the contract.",
    );
  }
  if (stepUp === null) {
    return apiError(422, "step_up_required", "Confirm the new mandate with your passkey.");
  }
  const { credentialId } = await service.stepUp.finish(scope.access, stepUp, {
    action: { kind: "create-mandate", name, rules },
    target: { workspaceId: scope.access.workspace.id, contract: null },
  });
  const created = await service.mandates.create(scope.access, { name, rules, credentialId });
  const answer: CreatedMandateResponse = {
    mandate: mandateView(service, created.mandate),
    token: created.token,
    deployProblem: created.deployProblem,
    mcpUrl: service.config.mcpPublicUrl,
  };
  return json(answer, 201);
}, WORKSPACE);

/** The mandate the path names, when it is one of the session's workspace's; null otherwise. */
function pathMandate(service: ConsoleService, scope: ConsoleScope, id: string | undefined): Mandate | null {
  const mandate = id ? service.accounts.store.mandate(id) : null;
  return mandate && mandate.workspaceId === scope.access.workspace.id ? mandate : null;
}

/** GET /api/console/mandates/:mandateId/deployment: what the owner's wallet sends to deploy its contract. */
export const getDeployment = consoleRoute(async (_request, service, scope, params) => {
  const mandate = pathMandate(service, scope, params.mandateId);
  if (!mandate) return apiError(404, "not_found", "This workspace has no such mandate.");
  if (mandate.deployment !== null)
    return apiError(409, "has_contract", "This mandate already has its contract.");
  if (service.mandates.deployer() !== "wallet" || service.accounts.store.ownerKeyOf(mandate.id)) {
    return apiError(409, "server_deployed", "The console deploys this mandate's contract itself.");
  }
  const request = await service.mandates.walletRequest(mandate);
  if (!request) {
    return apiError(
      503,
      "chain_unavailable",
      "The console can't prepare the deployment right now. Try again shortly.",
    );
  }
  const view: WalletDeployView = request;
  return json(view);
}, WORKSPACE);

const deploySchema = z.strictObject({ txHash: txHashSchema.nullable() });

/**
 * POST /api/console/mandates/:mandateId/deployment: on Arc, the owner wallet's deployment transaction,
 * which the console checks before following the contract; on the demo chain (`txHash: null`), the console
 * deploys again after a failed first try, with no rules (the contract then allows nothing until the
 * owner sets rules, with a passkey).
 */
export const postDeployment = consoleRoute(async (request, service, scope, params) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const mandate = pathMandate(service, scope, params.mandateId);
  if (!mandate) return apiError(404, "not_found", "This workspace has no such mandate.");
  const body = await readBody(request, deploySchema);
  if (!body.ok) return body.response;
  // A mandate that has its contract keeps it: the env mandate follows the server's own contract, and a
  // deployed mandate's agent, executor and journals are bound to its address. Either branch refuses.
  if (mandate.deployment !== null)
    return apiError(409, "has_contract", "This mandate already has its contract.");
  let attached: Mandate;
  if (body.data.txHash === null) {
    try {
      attached = await service.mandates.deployFromServer(mandate);
    } catch (error) {
      if (error instanceof DeployError) return apiError(409, error.code, error.message);
      throw error;
    }
  } else {
    attached = await service.mandates.attachWalletDeployment(mandate, body.data.txHash);
  }
  service.changed(attached.id);
  return json(mandateView(service, attached));
}, WORKSPACE);

const renameSchema = z.strictObject({ name: mandateNameSchema });

/**
 * PATCH /api/console/mandates/:mandateId: renames the mandate, on an admin's session alone. The name is a
 * label for people and the agent; nothing binds to it (a passkey confirms the mandate id and its contract,
 * never its name), so it takes no passkey. Recorded in the owner actions with the old and the new name.
 */
export const patchMandate = consoleRoute(async (request, service, scope, params) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const mandate = pathMandate(service, scope, params.mandateId);
  if (!mandate) return apiError(404, "not_found", "This workspace has no such mandate.");
  const body = await readBody(request, renameSchema);
  if (!body.ok) return body.response;
  const renamed = service.accounts.store.renameMandate({
    mandateId: mandate.id,
    memberId: scope.access.member.id,
    name: body.data.name,
  });
  if (!renamed) return apiError(404, "not_found", "This workspace has no such mandate.");
  service.changed(renamed.id);
  return json(mandateView(service, renamed));
}, WORKSPACE);

/** Where an action on `mandate` acts: its workspace and its contract, or null when it has none of its own. */
function targetOf(mandate: Mandate): StepUpTarget | null {
  if (mandate.deployment !== "server" || !mandate.contract) return null;
  return {
    workspaceId: mandate.workspaceId,
    contract: { chainId: mandate.contract.chainId, address: mandate.contract.address.toLowerCase() },
  };
}

/**
 * POST /api/console/step-up: a passkey challenge for one action. Creating a mandate is the workspace's;
 * creating a token names one of the workspace's agents; an owner action names one of the workspace's
 * mandates whose owner key the console holds. Another workspace's agent or mandate is a 404, as one that
 * does not exist.
 */
export const startStepUp = consoleRoute(async (request, service, scope) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const body = await readBody(request, z.strictObject({ action: stepUpActionSchema }));
  if (!body.ok) return body.response;
  const wait = service.accounts.limits.stepUps.take(
    `${scope.access.member.id}:${clientKey(request, service.config.accounts.trustProxy)}`,
  );
  if (wait > 0) return limited(wait, "Too many passkey confirmations.");
  const action: StepUpAction = body.data.action;
  let target: StepUpTarget | null;
  if (action.kind === "create-mandate") {
    target = { workspaceId: scope.access.workspace.id, contract: null };
  } else if (action.kind === "create-token") {
    const agent = service.accounts.store.agent(action.agentId);
    const mandate = agent ? pathMandate(service, scope, agent.mandateId) : null;
    if (!mandate) return apiError(404, "not_found", "This workspace has no such agent.");
    target = { workspaceId: scope.access.workspace.id, contract: null };
  } else {
    const mandate = pathMandate(service, scope, action.mandateId);
    if (!mandate) return apiError(404, "not_found", "This workspace has no such mandate.");
    target = targetOf(mandate);
    if (!target) {
      return apiError(409, "not_console_owned", "This mandate's owner signs with their own wallet.");
    }
  }
  const started = await service.stepUp.begin(scope.access, action, target);
  return json({ id: started.id, options: started.options }, 201);
}, WORKSPACE);

const ownerCallBodySchema = z.strictObject({
  call: ownerCallSchema,
  stepUp: stepUpAnswerSchema.nullable(),
});

/**
 * POST /api/console/owner-calls?mandate=: the console signs one owner call with the owner key it holds for
 * the mandate's contract and sends it. Every call but a pause needs the passkey confirmation of exactly
 * this call on exactly this mandate; a pause (the kill switch) is a session's alone.
 */
export const postOwnerCall = consoleRoute(async (request, service, scope) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const body = await readBody(request, ownerCallBodySchema);
  if (!body.ok) return body.response;
  const { call, stepUp } = body.data;
  const mandate = scope.mandate;
  const target = targetOf(mandate);
  if (!target) return apiError(409, "not_console_owned", "This mandate's owner signs with their own wallet.");
  let credentialId: string | null = null;
  if (needsPasskey(call)) {
    if (stepUp === null) {
      return apiError(422, "step_up_required", "Confirm this with your passkey.");
    }
    const confirmed = await service.stepUp.finish(scope.access, stepUp, {
      action: { kind: "owner-call", mandateId: mandate.id, call },
      target,
    });
    credentialId = confirmed.credentialId;
  }
  const sent = await service.mandates.ownerCall(scope.access, mandate, call, credentialId);
  return json({ hash: sent.hash }, 201);
});

/** GET /api/console/owner-actions?mandate=: the owner calls the console signed for this mandate. */
export const listOwnerActions = consoleRoute((_request, service, { mandate }) => {
  return json({ actions: service.accounts.store.ownerActions(mandate.id, 200) });
});
