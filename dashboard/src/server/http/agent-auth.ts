import "server-only";

import {
  type ResolveTokenResponse,
  agentTransactionRefusal,
  fromUnsignedTransaction,
  resolveTokenRequestSchema,
  resolveTokenResponseSchema,
  signTransactionRequestSchema,
  signTransactionResponseSchema,
} from "@mandate/shared";

import { localAgentSigner } from "../accounts/keys";
import { clientKey } from "../accounts/rate-limit";
import { agentRoute, serviceRoute } from "./agent-api";
import { apiError, json, readBody } from "./responses";

/**
 * The two agent routes that are about the agent itself rather than its records: which agent a bearer
 * token belongs to, and signing as a console-held agent (docs/accounts.md).
 */

/**
 * POST /api/agent/v1/auth/resolve: the MCP server asks which agent a presented token belongs to. The
 * console looks the hash up (never the token: the MCP server sends only its SHA-256) and answers 404 for
 * an unknown or revoked one, the same either way. Lookups that fail are rate limited.
 */
export const resolveToken = serviceRoute(async (request, service) => {
  const body = await readBody(request, resolveTokenRequestSchema);
  if (!body.ok) return body.response;
  const found = service.accounts.store.resolveToken(body.data.tokenHash, body.data.legacy);
  if (!found) {
    const wait = service.accounts.limits.failedTokens.take(clientKey(request, false));
    if (wait > 0) return limited(wait);
    return apiError(404, "unknown_token", "No live agent token has that hash.");
  }
  // The MCP server resolves the token of every MCP call: a Bot run of that mandate is in progress.
  service.noteAgentActivity(found.mandate);
  const answer: ResolveTokenResponse = {
    workspaceId: found.mandate.workspaceId,
    mandateId: found.mandate.id,
    agentId: found.agent.id,
    tokenId: found.token.id,
    agent: { address: found.agent.address, signer: found.agent.signer },
    mandate: {
      name: found.mandate.name,
      deployment: found.mandate.deployment,
      contract: found.mandate.contract
        ? {
            chainId: found.mandate.contract.chainId,
            address: found.mandate.contract.address,
            deployBlock: found.mandate.contract.deployBlock,
          }
        : null,
    },
  };
  return json(resolveTokenResponseSchema.parse(answer));
});

/**
 * POST /api/agent/v1/signer/transactions: signs a transaction as the named agent, when the console holds
 * its key. It signs only what an agent may send: `proposeTrade` to the agent's own mandate's Policy
 * contract, on that contract's chain, with no value. Anything else is refused before the key is opened.
 */
export const signTransaction = agentRoute(async (request, service, { agent, mandate }) => {
  const body = await readBody(request, signTransactionRequestSchema);
  if (!body.ok) return body.response;
  if (agent.signer !== "console" || agent.address === null || agent.sealedKey === null) {
    return apiError(409, "not_custodial", "The console holds no key for this agent; its own server signs.");
  }
  if (mandate.deployment === null) {
    return apiError(
      409,
      "no_contract",
      "This mandate has no Policy contract yet, so its agent has nothing to sign.",
    );
  }
  const chain = await service.chainFor(mandate);
  if (!chain)
    return apiError(503, "chain_unavailable", "The console can't read the Policy contract right now.");
  const refusal = agentTransactionRefusal(body.data.transaction, {
    policyAddress: chain.policy.address,
    chainId: chain.chainId,
  });
  if (refusal) return apiError(403, "refused", `The console will not sign this: ${refusal}.`);
  const signer = localAgentSigner(service.accounts.master, {
    id: agent.id,
    address: agent.address,
    sealedKey: agent.sealedKey,
  });
  const signed = await signer.signTransaction(fromUnsignedTransaction(body.data.transaction));
  return json(signTransactionResponseSchema.parse({ signed }));
});

function limited(seconds: number): Response {
  const response = apiError(429, "rate_limited", `Too many attempts. Try again in ${String(seconds)} s.`);
  response.headers.set("Retry-After", String(seconds));
  return response;
}
