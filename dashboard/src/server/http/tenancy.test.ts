import { readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { AGENT_ID_HEADER, type ConsoleError, consoleErrorSchema } from "@mandate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentsResponse } from "@/lib/accounts/types";
import type { ConsoleSnapshot } from "@/lib/live/types";

import {
  claimFirstWorkspace,
  consoleHeaders,
  envMandate,
  sessionHeader,
  signUpWorkspace,
  workspaceAgent,
} from "../../../test/support/accounts";
import type { Member } from "../accounts/store";
import { hashSecret } from "../accounts/secrets";
import { testConsoleConfig } from "../config";
import { setConsoleServiceForTests } from "../console";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { getHoldings, postPolicyChangeRequest } from "./agent-api";
import { resolveToken } from "./agent-auth";
import { createToken, listAgents, revokeToken } from "./agents-api";
import { eventStream } from "./event-stream";

/**
 * Isolation between workspaces, through every surface a member or an agent reaches: each console route,
 * the event stream, the agent API and token resolution (docs/accounts.md, "How each request is scoped").
 * Two workspaces: Alice claimed the first one, which follows the server's contract; Bob signed up.
 */

const TOKEN = "console-service-token-for-tests-0123456789";
const ORIGIN = "http://console.test";
const silent = { info: () => undefined, warn: () => undefined };

let service: ConsoleService;
let alice: Member;
let bob: Member;
let aliceAgent: string;
let bobAgent: string;
let aliceMandate: string;
let bobMandate: string;
let aliceRequestId: string;

function agentCall(method: string, path: string, agent: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      [AGENT_ID_HEADER]: agent,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function asMember(member: Member, method: string, path: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: consoleHeaders(service, member),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errorOf(response: Response): Promise<ConsoleError["error"]> {
  return consoleErrorSchema.parse(await response.json()).error;
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-tenancy-"));
  service = new ConsoleService(testConsoleConfig(dataDir, { serviceToken: TOKEN }), openDatabase(dataDir), {
    env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
    logger: silent,
  });
  setConsoleServiceForTests(service);
  alice = claimFirstWorkspace(service, "Alice");
  bob = signUpWorkspace(service, "Bob");
  const a = workspaceAgent(service, alice);
  const b = workspaceAgent(service, bob);
  aliceAgent = a.agent.id;
  bobAgent = b.agent.id;
  aliceMandate = a.mandate.id;
  bobMandate = b.mandate.id;
  expect(aliceMandate).toBe(envMandate(service).id);

  // Alice's mandate has holdings, and her agent files a change request.
  service.offchain.saveHoldings(aliceMandate, [{ asset: "BTC", quantity: "0.42" }]);
  const filed = await postPolicyChangeRequest(
    agentCall("POST", "/api/agent/v1/policy-change-requests", aliceAgent, {
      agentAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      proposed: { maxTradeCents: 3_000 },
      reason: "Alice's secret reason",
    }),
    service,
  );
  expect(filed.status).toBe(201);
  aliceRequestId = ((await filed.json()) as { id: string }).id;
});

afterAll(async () => {
  setConsoleServiceForTests(undefined);
  await service.stop();
});

describe("every console route", () => {
  const appDir = join(import.meta.dirname, "../../app/api/console");
  const routeFiles = (readdirSync(appDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(`${sep}route.ts`) || file === "route.ts")
    .sort();
  const params = Promise.resolve({ id: "x", agentId: "x", tokenId: "x" });
  type Handler = (request: Request, context: { params: typeof params }) => Promise<Response> | Response;

  async function handlers(): Promise<{ route: string; method: string; handler: Handler }[]> {
    const found = [];
    for (const file of routeFiles) {
      const routeModule = (await import(join(appDir, file))) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const handler = routeModule[method];
        if (typeof handler === "function") {
          found.push({ route: relative(appDir, join(appDir, file)), method, handler: handler as Handler });
        }
      }
    }
    return found;
  }

  it("is found: a new route shows up here, so it is checked below", async () => {
    const all = (await handlers()).map(({ route, method }) => `${method} ${route.split(sep).join("/")}`);
    expect(all.sort()).toEqual(
      [
        "GET agents/route.ts",
        "POST agents/[agentId]/tokens/route.ts",
        "DELETE agents/[agentId]/tokens/[tokenId]/route.ts",
        "POST change-requests/[id]/applied/route.ts",
        "POST change-requests/[id]/dismiss/route.ts",
        "GET events/route.ts",
        "GET hedge/market/route.ts",
        "PUT holdings/route.ts",
        "POST pairing/confirm/route.ts",
        "POST passkeys/route.ts",
        "GET snapshot/route.ts",
      ].sort(),
    );
  });

  it("answers 401 without a session, 403 to a write from another site, and 404 for another workspace's mandate", async () => {
    for (const { route, method, handler } of await handlers()) {
      const write = method !== "GET";
      const url = `${ORIGIN}/api/console/${route}`;

      const anonymous = await handler(
        new Request(url, { method, headers: write ? { origin: ORIGIN } : {} }),
        { params },
      );
      expect(anonymous.status, `${method} ${route} without a session`).toBe(401);
      expect(anonymous.headers.get("cache-control"), `${method} ${route}`).toBe("no-store");

      if (write) {
        const crossSite = await handler(
          new Request(url, {
            method,
            headers: { cookie: sessionHeader(service, bob), origin: "https://evil.example" },
          }),
          { params },
        );
        expect(crossSite.status, `${method} ${route} from another site`).toBe(403);
        const noOrigin = await handler(
          new Request(url, { method, headers: { cookie: sessionHeader(service, bob) } }),
          { params },
        );
        expect(noOrigin.status, `${method} ${route} without an Origin`).toBe(403);
      }

      const foreign = await handler(
        new Request(`${url}?mandate=${aliceMandate}`, {
          method,
          headers: { cookie: sessionHeader(service, bob), ...(write ? { origin: ORIGIN } : {}) },
        }),
        { params },
      );
      expect(foreign.status, `${method} ${route} for another workspace's mandate`).toBe(404);
      const unknown = await handler(
        new Request(`${url}?mandate=mnd_does_not_exist`, {
          method,
          headers: { cookie: sessionHeader(service, bob), ...(write ? { origin: ORIGIN } : {}) },
        }),
        { params },
      );
      expect(unknown.status, `${method} ${route} for a mandate that does not exist`).toBe(404);
      expect(await errorOf(unknown)).toEqual(await errorOf(foreign));
    }
  });
});

describe("reads across workspaces", () => {
  it("gives each member a snapshot of their own mandate only", async () => {
    const { GET } = await import("@/app/api/console/snapshot/route");
    const mine = (await (
      await GET(asMember(alice, "GET", "/api/console/snapshot"))
    ).json()) as ConsoleSnapshot;
    const theirs = (await (
      await GET(asMember(bob, "GET", "/api/console/snapshot"))
    ).json()) as ConsoleSnapshot;
    expect(mine.offchain.holdings).toEqual([{ asset: "BTC", quantity: "0.42" }]);
    expect(mine.offchain.changeRequests.map((r) => r.id)).toEqual([aliceRequestId]);
    expect(theirs.offchain.holdings).toEqual([]);
    expect(theirs.offchain.changeRequests).toEqual([]);
    expect(theirs.contract).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain("Alice's secret reason");
    expect(JSON.stringify(theirs)).not.toContain(aliceRequestId);
  });

  it("streams each member their own mandate, before and after the other one changes", async () => {
    const opened = await eventStream(asMember(bob, "GET", "/api/console/events"), service);
    expect(opened.status).toBe(200);
    const reader = opened.body?.getReader();
    if (!reader) throw new Error("no stream");
    const decoder = new TextDecoder();
    let text = "";
    const nextSnapshot = async (): Promise<ConsoleSnapshot> => {
      for (;;) {
        const match = /data: (.*)\n\n/.exec(text);
        if (match?.[1]) {
          text = text.slice(match.index + match[0].length);
          return JSON.parse(match[1]) as ConsoleSnapshot;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the stream ended");
        text += decoder.decode(chunk.value);
      }
    };
    const first = await nextSnapshot();
    expect(first.offchain.changeRequests).toEqual([]);

    const filed = await postPolicyChangeRequest(
      agentCall("POST", "/api/agent/v1/policy-change-requests", aliceAgent, {
        agentAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        proposed: { maxTradeCents: 4_000 },
        reason: "Alice's second secret",
      }),
      service,
    );
    expect(filed.status).toBe(201);
    const after = await nextSnapshot();
    expect(after.seq).toBeGreaterThan(first.seq);
    expect(after.offchain.changeRequests).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("Alice's second secret");
    await reader.cancel();
  });

  it("ends a stream when its session signs out, and leaves another session's open", async () => {
    const open = async () => {
      const cookie = sessionHeader(service, bob);
      const response = await eventStream(
        new Request(`${ORIGIN}/api/console/events`, { headers: { cookie } }),
        service,
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no stream");
      await reader.read();
      return { reader, sessionId: cookie.slice(cookie.indexOf("=") + 1) };
    };
    const stolen = await open();
    const other = await open();
    service.accounts.closeSession(stolen.sessionId);
    // Ended at once: nothing more arrives on it, whatever changes next.
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await stolen.reader.read()).done) return "ended";
      })(),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]);
    expect(ended).toBe("ended");
    // The other session's stream still gets the next change.
    const decoder = new TextDecoder();
    const holdingsBefore = service.offchain.holdings(bobMandate).holdings;
    try {
      service.offchain.saveHoldings(bobMandate, [{ asset: "ETH", quantity: "1" }]);
      service.changed();
      let text = "";
      while (!text.includes('"ETH"')) {
        const chunk = await other.reader.read();
        if (chunk.done) throw new Error("the other session's stream ended");
        text += decoder.decode(chunk.value);
      }
    } finally {
      await other.reader.cancel();
      service.offchain.saveHoldings(bobMandate, holdingsBefore);
    }
  });

  it("lists each member their own agents only", async () => {
    const listed = (await (
      await listAgents(asMember(bob, "GET", "/api/console/agents"), service)
    ).json()) as AgentsResponse;
    expect(listed.agents.map((agent) => agent.id)).toEqual([bobAgent]);
    expect(listed.agents[0]?.mandate.id).toBe(bobMandate);
  });
});

describe("writes across workspaces", () => {
  it("cannot create or revoke a token of another workspace's agent", async () => {
    const { token, view } = service.accounts.store.createToken(aliceAgent, "Alice's Grok");
    const create = await createToken(
      asMember(bob, "POST", `/api/console/agents/${aliceAgent}/tokens`, { name: "stolen" }),
      service,
      { agentId: aliceAgent },
    );
    expect(create.status).toBe(404);
    const revoke = await revokeToken(
      asMember(bob, "DELETE", `/api/console/agents/${aliceAgent}/tokens/${view.id}`),
      service,
      { agentId: aliceAgent, tokenId: view.id },
    );
    expect(revoke.status).toBe(404);
    // Naming his own agent with her token id reaches nothing either.
    const sideways = await revokeToken(
      asMember(bob, "DELETE", `/api/console/agents/${bobAgent}/tokens/${view.id}`),
      service,
      { agentId: bobAgent, tokenId: view.id },
    );
    expect(sideways.status).toBe(404);
    expect(service.accounts.store.resolveToken(hashSecret(token), false)?.agent.id).toBe(aliceAgent);
  });

  // Owner-signed writes (holdings, pairing, change requests) across workspaces: owner-api.test.ts, with a
  // real contract and wallet signatures.
});

describe("agents across workspaces", () => {
  it("resolves each token to its own agent and mandate, and a revoked one to nothing", async () => {
    const mine = service.accounts.store.createToken(bobAgent, "Bob's Grok");
    const resolved = await resolveToken(
      agentCall("POST", "/api/agent/v1/auth/resolve", bobAgent, {
        tokenHash: hashSecret(mine.token),
        legacy: false,
      }),
      service,
    );
    expect(await resolved.json()).toMatchObject({ agentId: bobAgent, mandateId: bobMandate });
    service.accounts.store.revokeToken(bobAgent, mine.view.id);
    const revoked = await resolveToken(
      agentCall("POST", "/api/agent/v1/auth/resolve", bobAgent, {
        tokenHash: hashSecret(mine.token),
        legacy: false,
      }),
      service,
    );
    expect(revoked.status).toBe(404);
  });

  it("reads and writes only the named agent's mandate", async () => {
    const holdings = await getHoldings(agentCall("GET", "/api/agent/v1/holdings", bobAgent), service);
    expect(await holdings.json()).toMatchObject({ holdings: [] });
    const { GET } = await import("@/app/api/agent/v1/policy-change-requests/[id]/route");
    const foreign = await GET(
      agentCall("GET", `/api/agent/v1/policy-change-requests/${aliceRequestId}`, bobAgent),
      {
        params: Promise.resolve({ id: aliceRequestId }),
      },
    );
    expect(foreign.status).toBe(404);
    const own = await GET(
      agentCall("GET", `/api/agent/v1/policy-change-requests/${aliceRequestId}`, aliceAgent),
      {
        params: Promise.resolve({ id: aliceRequestId }),
      },
    );
    expect(own.status).toBe(200);
  });
});
