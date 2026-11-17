import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_ID_HEADER, CONSOLE_AGENT_ROUTES, hashAgentToken } from "@mandate/shared";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SoftPasskey } from "../../../test/support/passkey";
import { testConsoleConfig } from "../config";
import { setConsoleServiceForTests } from "../console";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import { resolveToken, signTransaction } from "../http/agent-auth";
import { createToken, listAgents, revokeToken } from "../http/agents-api";
import {
  currentSession,
  finishRegistration,
  finishSignIn,
  startClaim,
  startSignIn,
  startSignUp,
} from "../http/auth-api";
import { eventStream } from "../http/event-stream";
import { sessionCookieName } from "../http/session";
import { DEV_MASTER_KEY_FILE, openAgentKey } from "./keys";

/**
 * No secret leaves the console except where it is meant to be shown once (docs/accounts.md, "Tokens and codes" and "Threat model"):
 * session ids, agent tokens, claim and recovery codes, the master key and the agents' private keys never
 * reach a log line, an error message, a snapshot, the event stream or any other answer.
 *
 * The test runs the account flows end to end through the routes, with every log and console output
 * captured, then searches everything it saw for every secret it knows of.
 */

const ORIGIN = "http://console.test";
const SERVICE_TOKEN = "console-service-token-for-redaction-0123456789";

let service: ConsoleService;
let dataDir: string;
const logged: string[] = [];
/** Every answer and every view the test saw, except the two that show a secret once, by design. */
const seen: string[] = [];
/** The answers whose whole point is to show a secret once. */
const shownOnce: { what: string; text: string }[] = [];
const secrets = new Map<string, string>();

function remember(name: string, value: string) {
  secrets.set(name, value);
}

async function record(response: Response): Promise<Response> {
  const text = await response.clone().text();
  // Set-Cookie is where a session or ceremony id belongs; every other header and the body are searched.
  const headers = [...response.headers].filter(([name]) => name.toLowerCase() !== "set-cookie");
  seen.push(headers.map(([name, value]) => `${name}: ${value}`).join("\n"), text);
  return response;
}

function request(method: string, path: string, init: { cookie?: string; body?: unknown } = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function agentRequest(path: string, agentId: string | null, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
      ...(agentId === null ? {} : { [AGENT_ID_HEADER]: agentId }),
    },
    body: JSON.stringify(body),
  });
}

/** Cookies a response set, by name. */
function cookiesOf(response: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return cookies;
}

/** A registration through the routes: the start route, the passkey, then /api/auth/register. */
async function register(
  start: typeof startClaim,
  path: string,
  body: unknown,
  passkey: SoftPasskey,
): Promise<{ session: string; recoveryCode: string }> {
  const started = await record(await start(request("POST", path, { body }), service));
  const ceremony = [...cookiesOf(started)].map(([name, value]) => `${name}=${value}`).join("; ");
  const { options } = (await started.json()) as { options: PublicKeyCredentialCreationOptionsJSON };
  const finished = await finishRegistration(
    request("POST", "/api/auth/register", { cookie: ceremony, body: { response: passkey.create(options) } }),
    service,
  );
  const text = await finished.clone().text();
  shownOnce.push({ what: "recovery code", text });
  const session = cookiesOf(finished).get(sessionCookieName(service.config.accounts)) ?? "";
  return { session, recoveryCode: ((await finished.json()) as { recoveryCode: string }).recoveryCode };
}

async function firstEvent(cookie: string): Promise<string> {
  const opened = await eventStream(request("GET", "/api/console/events", { cookie }), service);
  const reader = opened.body?.getReader();
  if (!reader) throw new Error("no stream");
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

beforeAll(async () => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  dataDir = mkdtempSync(join(tmpdir(), "mandate-redaction-"));
  const capture = (level: string) => (message: string, fields?: unknown) => {
    logged.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  service = new ConsoleService(
    testConsoleConfig(dataDir, { serviceToken: SERVICE_TOKEN }),
    openDatabase(dataDir),
    {
      env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
      logger: { info: capture("info"), warn: capture("warn") },
    },
  );
  setConsoleServiceForTests(service);
  remember("service token", SERVICE_TOKEN);
  remember("master key", readFileSync(join(dataDir, DEV_MASTER_KEY_FILE), "utf8").trim());
  remember("master key (hex)", service.accounts.master.bytes().toString("hex"));
  remember("master key (base64)", service.accounts.master.bytes().toString("base64"));

  // Alice claims the first workspace with the operator's code, then signs in again.
  const { code } = service.accounts.issueClaimCode();
  remember("claim code", code);
  const alicePasskey = new SoftPasskey(ORIGIN);
  const alice = await register(
    startClaim,
    "/api/auth/claim",
    { name: "Alice", claimCode: code },
    alicePasskey,
  );
  remember("Alice's first session", alice.session);
  remember("Alice's recovery code", alice.recoveryCode);
  const signInStart = await record(await startSignIn(request("POST", "/api/auth/sign-in"), service));
  const ceremony = [...cookiesOf(signInStart)].map(([name, value]) => `${name}=${value}`).join("; ");
  remember("a ceremony id", [...cookiesOf(signInStart).values()][0] ?? "");
  const { options } = (await signInStart.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
  const signedIn = await record(
    await finishSignIn(
      request("POST", "/api/auth/sign-in/verify", {
        cookie: ceremony,
        body: { response: alicePasskey.get(options) },
      }),
      service,
    ),
  );
  const aliceSession = cookiesOf(signedIn).get(sessionCookieName(service.config.accounts)) ?? "";
  remember("Alice's session", aliceSession);
  const aliceCookie = `${sessionCookieName(service.config.accounts)}=${aliceSession}`;

  // Bob signs up: a workspace of his own, whose agent's key the console holds.
  const bob = await register(
    startSignUp,
    "/api/auth/sign-up",
    { name: "Bob", inviteCode: null },
    new SoftPasskey(ORIGIN),
  );
  remember("Bob's session", bob.session);
  remember("Bob's recovery code", bob.recoveryCode);
  const bobCookie = `${sessionCookieName(service.config.accounts)}=${bob.session}`;
  const bobAccess = service.accounts.access(bob.session);
  if (!bobAccess) throw new Error("Bob is not signed in");
  const [bobAgent] = service.accounts.store.agentsOf(bobAccess.workspace.id);
  if (!bobAgent?.agent.sealedKey) throw new Error("Bob's agent has no sealed key");
  const privateKey = openAgentKey(service.accounts.master, bobAgent.agent.id, bobAgent.agent.sealedKey);
  remember("Bob's agent key", privateKey);
  remember("Bob's agent key (no 0x)", privateKey.slice(2));
  remember("Bob's sealed agent key", bobAgent.agent.sealedKey);

  // Bob makes a token, his agent uses it, and he revokes it.
  const tokensPath = `/api/console/agents/${bobAgent.agent.id}/tokens`;
  const created = await createToken(
    request("POST", tokensPath, { cookie: bobCookie, body: { name: "Grok" } }),
    service,
    { agentId: bobAgent.agent.id },
  );
  expect(created.status).toBe(201);
  const createdText = await created.clone().text();
  shownOnce.push({ what: "agent token", text: createdText });
  const { token, view } = (await created.json()) as { token: string; view: { id: string } };
  remember("Bob's agent token", token);
  const resolve = (hash: string) =>
    resolveToken(
      agentRequest(CONSOLE_AGENT_ROUTES.resolveToken, null, { tokenHash: hash, legacy: false }),
      service,
    );
  expect((await record(await resolve(hashAgentToken(token)))).status).toBe(200);
  expect(
    (
      await record(
        await revokeToken(request("DELETE", `${tokensPath}/${view.id}`, { cookie: bobCookie }), service, {
          agentId: bobAgent.agent.id,
          tokenId: view.id,
        }),
      )
    ).status,
  ).toBe(200);
  expect((await record(await resolve(hashAgentToken(token)))).status).toBe(404);

  // Failures, where a careless message would quote what it was given.
  // A token pasted as a new token's name is refused, so the Agents list never shows it.
  const pasted = await record(
    await createToken(request("POST", tokensPath, { cookie: bobCookie, body: { name: token } }), service, {
      agentId: bobAgent.agent.id,
    }),
  );
  expect(pasted.status).toBe(422);
  await record(await resolve(token));
  await record(
    await signTransaction(
      agentRequest("/api/agent/v1/signer/transactions", bobAgent.agent.id, { transaction: { token } }),
      service,
    ),
  );
  await record(
    await finishSignIn(
      request("POST", "/api/auth/sign-in/verify", { cookie: ceremony, body: { response: { id: token } } }),
      service,
    ),
  );
  await record(
    await startClaim(
      request("POST", "/api/auth/claim", { body: { name: "Eve", claimCode: alice.recoveryCode } }),
      service,
    ),
  );
  await record(
    await currentSession(request("GET", "/api/auth/session", { cookie: `${aliceCookie}x` }), service),
  );

  // Everything a member sees: the agents list, the snapshot and the live stream, for both workspaces.
  for (const cookie of [aliceCookie, bobCookie]) {
    await record(await listAgents(request("GET", "/api/console/agents", { cookie }), service));
    seen.push(await firstEvent(cookie));
  }
  seen.push(JSON.stringify(service.snapshot(service.accounts.store.envMandate())));
});

afterAll(async () => {
  vi.restoreAllMocks();
  setConsoleServiceForTests(undefined);
  await service.stop();
});

describe("secrets", () => {
  it("knows every secret it searches for", () => {
    for (const [name, value] of secrets) expect(value.length, name).toBeGreaterThanOrEqual(8);
    expect(logged.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(10);
  });

  it("never reach a log line or the console's output", () => {
    const text = logged.join("\n");
    for (const [name, value] of secrets) expect(text.includes(value), name).toBe(false);
  });

  it("never reach an answer, an error message, a snapshot or the event stream", () => {
    for (const [name, value] of secrets) {
      const leaks = seen.filter((text) => text.includes(value)).map((text) => text.slice(0, 300));
      expect(leaks, name).toEqual([]);
    }
  });

  it("are shown once where that is the point, and nothing else is shown with them", () => {
    const [tokenAnswer] = shownOnce.filter((answer) => answer.what === "agent token");
    expect(tokenAnswer?.text).toContain(secrets.get("Bob's agent token"));
    for (const answer of shownOnce) {
      for (const [name, value] of secrets) {
        if (name.includes("recovery code") || name.includes("agent token")) continue;
        expect(answer.text.includes(value), `${name} in the ${answer.what} answer`).toBe(false);
      }
    }
  });
});
