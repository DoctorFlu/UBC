import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONSOLE_AGENT_ROUTES, ENV_AGENT_ID, hashAgentToken } from "@mandate/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  claimFirstWorkspace,
  consoleHeaders,
  signUpWorkspace,
  workspaceAgent,
} from "../../../test/support/accounts";
import { testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { resolveToken } from "./agent-auth";
import { createToken, listAgents, revokeToken } from "./agents-api";

/**
 * The env file's MCP_AUTH_TOKEN as the console sees it (docs/accounts.md, "The env-file token"): the MCP
 * server presents it with `legacy: true`, the console registers it once for the first mandate's agent,
 * and a revoke is final.
 */

const SERVICE_TOKEN = "console-service-token-for-agent-auth-0123456789";
const ORIGIN = "http://console.test";
const ENV_TOKEN = "the-env-file-token-of-this-server-0123456789abcdef";
const services: ConsoleService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

function newService() {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-agent-auth-"));
  const service = new ConsoleService(
    testConsoleConfig(dataDir, { serviceToken: SERVICE_TOKEN }),
    openDatabase(dataDir),
    {
      env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
      logger: { info: () => undefined, warn: () => undefined },
    },
  );
  services.push(service);
  return service;
}

function resolve(service: ConsoleService, token: string, legacy: boolean) {
  return resolveToken(
    new Request(`${ORIGIN}${CONSOLE_AGENT_ROUTES.resolveToken}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tokenHash: hashAgentToken(token), legacy }),
    }),
    service,
  );
}

describe("the env file's token", () => {
  it("is registered for the first mandate's agent on first use, before the workspace is claimed", async () => {
    const service = newService();
    const first = await resolve(service, ENV_TOKEN, true);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ agentId: ENV_AGENT_ID, mandate: { deployment: "env" } });
    // The same token again: the same agent, and no second registration.
    expect((await resolve(service, ENV_TOKEN, true)).status).toBe(200);
    // Presented without the legacy flag (as a console token would be), it is not one.
    expect((await resolve(service, ENV_TOKEN, false)).status).toBe(404);
  });

  it("is never replaced by another env-file token, and a revoke is final", async () => {
    const service = newService();
    expect((await resolve(service, ENV_TOKEN, true)).status).toBe(200);
    expect((await resolve(service, "a-second-env-file-token-0123456789abcdefgh", true)).status).toBe(404);

    const owner = claimFirstWorkspace(service, "Owner");
    const listed = (await (
      await listAgents(
        new Request(`${ORIGIN}/api/console/agents`, { headers: consoleHeaders(service, owner) }),
        service,
      )
    ).json()) as { agents: { id: string; tokens: { id: string; source: string }[] }[] };
    const envToken = listed.agents
      .find((agent) => agent.id === ENV_AGENT_ID)
      ?.tokens.find((t) => t.source === "env");
    if (!envToken) throw new Error("the env-file token is not listed");
    const revoked = await revokeToken(
      new Request(`${ORIGIN}/api/console/agents/${ENV_AGENT_ID}/tokens/${envToken.id}`, {
        method: "DELETE",
        headers: consoleHeaders(service, owner),
      }),
      service,
      { agentId: ENV_AGENT_ID, tokenId: envToken.id },
    );
    expect(revoked.status).toBe(200);
    expect((await resolve(service, ENV_TOKEN, true)).status).toBe(404);
    // A new value in the env file cannot bring the server's agent back: tokens come from the console now.
    expect((await resolve(service, "a-rotated-env-file-token-0123456789abcdefg", true)).status).toBe(404);
  });

  it("cannot be claimed by a console token, nor reach another workspace's agent", async () => {
    const service = newService();
    const bob = signUpWorkspace(service, "Bob");
    const bobAgent = workspaceAgent(service, bob).agent.id;
    const created = await createToken(
      new Request(`${ORIGIN}/api/console/agents/${bobAgent}/tokens`, {
        method: "POST",
        headers: consoleHeaders(service, bob),
        body: JSON.stringify({ name: "Grok" }),
      }),
      service,
      { agentId: bobAgent },
    );
    const { token } = (await created.json()) as { token: string };
    // Bob's token presented as if it were the env file's: refused, and it registers nothing.
    expect((await resolve(service, token, true)).status).toBe(404);
    expect(await (await resolve(service, token, false)).json()).toMatchObject({ agentId: bobAgent });
    expect((await resolve(service, ENV_TOKEN, true)).status).toBe(200);
  });
});
