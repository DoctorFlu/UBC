import "server-only";

import { AGENT_TOKEN_PREFIX } from "@mandate/shared";
import { z } from "zod";

import type { AgentsResponse, CreatedToken } from "@/lib/accounts/types";

import { isPlainText } from "../accounts/accounts";
import type { Agent, Mandate } from "../accounts/store";
import { clientKey } from "../accounts/rate-limit";
import type { ConsoleService } from "../console-service";
import { apiError, json, readBody } from "./responses";
import { type ConsoleScope, WORKSPACE, consoleRoute } from "./session";

/**
 * The Setup page's Agents section: the workspace's agents, and creating and revoking their tokens
 * (docs/accounts.md). A token is shown once, in the answer that creates it, and never again.
 */

/** The agent with this id, when it belongs to the session's workspace; null otherwise, the same as none. */
function ownAgent(
  service: ConsoleService,
  scope: ConsoleScope,
  agentId: string,
): { agent: Agent; mandate: Mandate } | null {
  const agent = service.accounts.store.agent(agentId);
  const mandate = agent ? service.accounts.store.mandate(agent.mandateId) : null;
  if (!agent || !mandate || mandate.workspaceId !== scope.access.workspace.id) return null;
  return { agent, mandate };
}

function adminOnly(scope: ConsoleScope): Response | null {
  return scope.access.member.role === "admin"
    ? null
    : apiError(403, "forbidden", "Only a workspace admin can manage agent tokens.");
}

/** GET /api/console/agents */
export const listAgents = consoleRoute((_request, service, scope) => {
  const body: AgentsResponse = {
    mcpUrl: service.config.mcpPublicUrl,
    agents: service.accounts.store.agentsOf(scope.access.workspace.id).map(({ mandate, agent }) => ({
      id: agent.id,
      name: agent.name,
      address: agent.address,
      mandate: { id: mandate.id, name: mandate.name, hasContract: mandate.deployment !== null },
      tokens: service.accounts.store.tokens(agent.id),
    })),
  };
  return json(body);
}, WORKSPACE);

const createTokenSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Name the token, for example after the app that will use it.")
    .max(60, "Use at most 60 characters.")
    .refine(isPlainText, "Use letters, digits and punctuation only.")
    // A token pasted into the name would be shown in the Agents list for as long as the token exists.
    .refine(
      (name) => !name.includes(AGENT_TOKEN_PREFIX),
      "That looks like a token. Name it after the app that will use it.",
    ),
});

/** POST /api/console/agents/:agentId/tokens: a new token, returned this once. */
export const createToken = consoleRoute(async (request, service, scope, params) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const own = ownAgent(service, scope, params.agentId ?? "");
  if (!own) return apiError(404, "not_found", "This workspace has no such agent.");
  const wait = service.accounts.limits.tokenCreation.take(
    `${scope.access.member.id}:${clientKey(request, service.config.accounts.trustProxy)}`,
  );
  if (wait > 0) {
    const response = apiError(429, "rate_limited", `Too many new tokens. Try again in ${String(wait)} s.`);
    response.headers.set("Retry-After", String(wait));
    return response;
  }
  const body = await readBody(request, createTokenSchema);
  if (!body.ok) return body.response;
  const { token, view } = service.accounts.store.createToken(own.agent.id, body.data.name);
  const created: CreatedToken = { token, view };
  return json(created, 201);
}, WORKSPACE);

/** DELETE /api/console/agents/:agentId/tokens/:tokenId: revokes a token at once. Revoking twice is fine. */
export const revokeToken = consoleRoute((_request, service, scope, params) => {
  const denied = adminOnly(scope);
  if (denied) return denied;
  const own = ownAgent(service, scope, params.agentId ?? "");
  const revoked = own ? service.accounts.store.revokeToken(own.agent.id, params.tokenId ?? "") : null;
  if (!revoked) return apiError(404, "not_found", "This agent has no such token.");
  return json(revoked);
}, WORKSPACE);
