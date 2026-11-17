import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { codeHash } from "../../../test/support/accounts";
import { SoftPasskey } from "../../../test/support/passkey";
import { AccountError, Accounts, CLAIM_CODE_TTL_MS } from "../accounts/accounts";
import { SESSION_IDLE_MS, SESSION_MAX_AGE_MS } from "../accounts/store";
import { readAccountsConfig, testConsoleConfig } from "../config";
import { ConsoleService } from "../console-service";
import { openDatabase } from "../db";
import {
  currentSession,
  finishRegistration,
  finishSignIn,
  forwardAuth,
  startClaim,
  startRecovery,
  startSignIn,
  startSignUp,
  signOut,
} from "./auth-api";
import { ceremonyCookie, ceremonyCookieName, sessionCookie, sessionCookieName } from "./session";

/**
 * The passkey ceremonies through the account routes, verified by SimpleWebAuthn against a software
 * passkey: claim, sign-up, sign-in, recovery and sign-out, and what each refuses (docs/accounts.md).
 */

const ORIGIN = "http://console.test";
const silent = { info: () => undefined, warn: () => undefined };
const services: ConsoleService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

function newService(accounts: Parameters<typeof testConsoleConfig>[1] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-auth-"));
  const service = new ConsoleService(testConsoleConfig(dataDir, accounts), openDatabase(dataDir), {
    env: { POLICY_DEPLOYMENT_FILE: join(dataDir, "missing.json") },
    logger: silent,
  });
  services.push(service);
  return Object.assign(service, { dataDir });
}

type Route = (request: Request, service: ConsoleService) => Promise<Response>;

/** A browser: it keeps the cookies the console sets and sends them back, from the console's origin. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(
    private readonly service: ConsoleService,
    private readonly origin = ORIGIN,
  ) {}

  async call(route: Route, path: string, body?: unknown, method = "POST"): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await route(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin: this.origin,
          ...(cookie === "" ? {} : { cookie }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      this.service,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "" || /Max-Age=0\b/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get session(): string | undefined {
    return this.cookies.get(sessionCookieName(this.service.config.accounts));
  }
}

async function optionsOf<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { options: T }).options;
}

/** Claims the first workspace with a new passkey: the operator's code, then the passkey. */
async function claim(service: ConsoleService, browser: Browser, passkey: SoftPasskey, code: string) {
  const options = await optionsOf<PublicKeyCredentialCreationOptionsJSON>(
    await browser.call(startClaim, "/api/auth/claim", { name: "Alice", claimCode: code }),
  );
  return browser.call(finishRegistration, "/api/auth/register", { response: passkey.create(options) });
}

async function signIn(browser: Browser, passkey: SoftPasskey, overrides: { origin?: string } = {}) {
  const options = await optionsOf<PublicKeyCredentialRequestOptionsJSON>(
    await browser.call(startSignIn, "/api/auth/sign-in"),
  );
  return browser.call(finishSignIn, "/api/auth/sign-in/verify", {
    response: passkey.get(options, overrides),
  });
}

describe("claiming the first workspace", () => {
  it("signs in the claimer with a new passkey and a recovery code, and the code works once", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const browser = new Browser(service);
    const passkey = new SoftPasskey(ORIGIN);
    const finished = await claim(service, browser, passkey, code);
    expect(finished.status).toBe(200);
    const body = (await finished.json()) as { status: string; recoveryCode: string };
    expect(body.status).toBe("signed-in");
    expect(body.recoveryCode).toMatch(/\S{8,}/);
    expect(browser.session).toEqual(expect.any(String));
    expect(service.accounts.store.firstWorkspace().claimedAt).not.toBeNull();
    // The ceremony cookie is spent.
    expect(browser.cookies.has(ceremonyCookieName(service.config.accounts))).toBe(false);

    const me = await browser.call(currentSession, "/api/auth/session", undefined, "GET");
    expect(await me.json()).toMatchObject({ member: { name: "Alice", role: "admin" } });

    // The same code, again, from anyone: refused before any passkey is asked for.
    const again = await new Browser(service).call(startClaim, "/api/auth/claim", {
      name: "Eve",
      claimCode: code,
    });
    expect(again.status).toBe(403);
    // A new claim code cannot be issued once the workspace is claimed.
    expect(() => service.accounts.issueClaimCode()).toThrow(/already claimed/);
  });

  it("stores only the hash of the code and of the session", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const browser = new Browser(service);
    await claim(service, browser, new SoftPasskey(ORIGIN), code);
    const dump = JSON.stringify(
      ["access_codes", "sessions", "members", "passkeys", "ceremonies"].map((table) =>
        openDatabase(service.dataDir).prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(code.replace(/-/g, ""));
    expect(dump).not.toContain(browser.session);
  });

  it("refuses a passkey made for another site, or answered from another origin", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    for (const overrides of [{ origin: "https://evil.example" }, { rpId: "evil.example" }]) {
      const browser = new Browser(service);
      const options = await optionsOf<PublicKeyCredentialCreationOptionsJSON>(
        await browser.call(startClaim, "/api/auth/claim", { name: "Alice", claimCode: code }),
      );
      const finished = await browser.call(finishRegistration, "/api/auth/register", {
        response: new SoftPasskey(ORIGIN).create(options, overrides),
      });
      expect(finished.status).toBe(400);
      expect(browser.session).toBeUndefined();
    }
    // The code was not spent by the failed attempts.
    expect(service.accounts.store.firstWorkspace().claimedAt).toBeNull();
  });

  it("refuses a request from another site before anything else", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const response = await new Browser(service, "https://evil.example").call(startClaim, "/api/auth/claim", {
      name: "Eve",
      claimCode: code,
    });
    expect(response.status).toBe(403);
  });

  it("uses each passkey prompt once", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const browser = new Browser(service);
    const passkey = new SoftPasskey(ORIGIN);
    const options = await optionsOf<PublicKeyCredentialCreationOptionsJSON>(
      await browser.call(startClaim, "/api/auth/claim", { name: "Alice", claimCode: code }),
    );
    const ceremony = browser.cookies.get(ceremonyCookieName(service.config.accounts)) ?? "";
    const answer = passkey.create(options);
    expect((await browser.call(finishRegistration, "/api/auth/register", { response: answer })).status).toBe(
      200,
    );
    browser.cookies.set(ceremonyCookieName(service.config.accounts), ceremony);
    const replay = await browser.call(finishRegistration, "/api/auth/register", { response: answer });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "ceremony_expired" } });
  });

  it("limits how many codes one client can try", async () => {
    const service = newService();
    service.accounts.issueClaimCode();
    const browser = new Browser(service);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await browser.call(startClaim, "/api/auth/claim", {
        name: "Eve",
        claimCode: `WRONG-CODE-${String(attempt).padStart(4, "0")}`,
      });
      statuses.push(response.status);
      if (response.status === 429) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(statuses.slice(0, 10).every((status) => status === 403 || status === 422)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("signing in and out", () => {
  async function claimed() {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const passkey = new SoftPasskey(ORIGIN);
    await claim(service, new Browser(service), passkey, code);
    return { service, passkey };
  }

  it("signs in with the passkey and gives a new session, closing any session the browser had", async () => {
    const { service, passkey } = await claimed();
    const browser = new Browser(service);
    expect((await signIn(browser, passkey)).status).toBe(200);
    const first = browser.session ?? "";
    expect(service.accounts.access(first)).not.toBeNull();

    // A session id planted in the browser beforehand is never the one signed in (no fixation).
    expect((await signIn(browser, passkey)).status).toBe(200);
    const second = browser.session ?? "";
    expect(second).not.toBe(first);
    expect(service.accounts.access(first)).toBeNull();
    expect(service.accounts.access(second)).not.toBeNull();
  });

  it("refuses a passkey it does not know, and an answer meant for another origin", async () => {
    const { service, passkey } = await claimed();
    const stranger = await signIn(new Browser(service), new SoftPasskey(ORIGIN));
    expect(stranger.status).toBe(401);
    const wrongOrigin = await signIn(new Browser(service), passkey, { origin: "https://evil.example" });
    expect(wrongOrigin.status).toBe(401);
    // Both read the same, so a guess learns nothing about which passkeys exist.
    expect(await stranger.json()).toEqual(await wrongOrigin.json());
  });

  it("ends the session on sign-out, and the reverse proxy then sends the browser to sign in", async () => {
    const { service, passkey } = await claimed();
    const browser = new Browser(service);
    await signIn(browser, passkey);
    const session = browser.session ?? "";
    const forward = (accept: string) =>
      forwardAuth(
        new Request(`${ORIGIN}/api/auth/forward`, {
          headers: {
            cookie: `${sessionCookieName(service.config.accounts)}=${session}`,
            accept,
            "x-forwarded-method": "GET",
            "x-forwarded-uri": "/hedge?x=1",
          },
        }),
        service,
      );
    expect((await forward("text/html")).status).toBe(204);
    expect((await browser.call(signOut, "/api/auth/sign-out")).status).toBe(200);
    expect(browser.session).toBeUndefined();
    expect(service.accounts.access(session)).toBeNull();
    const page = await forward("text/html");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/hedge?x=1")}`);
    expect((await forward("application/json")).status).toBe(401);
  });

  it("recovers with the recovery code: a new passkey, and the code is replaced", async () => {
    const service = newService();
    const { code } = service.accounts.issueClaimCode();
    const finished = await claim(service, new Browser(service), new SoftPasskey(ORIGIN), code);
    const { recoveryCode } = (await finished.json()) as { recoveryCode: string };

    const browser = new Browser(service);
    const replacement = new SoftPasskey(ORIGIN);
    const options = await optionsOf<PublicKeyCredentialCreationOptionsJSON>(
      await browser.call(startRecovery, "/api/auth/recover", { recoveryCode }),
    );
    const recovered = await browser.call(finishRegistration, "/api/auth/register", {
      response: replacement.create(options),
    });
    expect(recovered.status).toBe(200);
    const next = ((await recovered.json()) as { recoveryCode: string }).recoveryCode;
    expect(next).not.toBe(recoveryCode);
    expect((await signIn(new Browser(service), replacement)).status).toBe(200);
    // The old code is spent.
    const reuse = await new Browser(service).call(startRecovery, "/api/auth/recover", { recoveryCode });
    expect(reuse.status).toBe(403);
  });

  it("answers a refusal thrown by another copy of the accounts module as that refusal, not a 500", async () => {
    // Next.js may load a server module more than once; the shared service then throws the AccountError
    // class of the copy that built it (seen in `next dev`: a spent recovery code answered 500).
    vi.resetModules();
    const copy = await import("../accounts/accounts");
    expect(copy.AccountError).not.toBe(AccountError);
    const service = newService();
    vi.spyOn(service.accounts, "startRegistration").mockRejectedValue(
      new copy.AccountError(403, "invalid_code", "That recovery code is not valid."),
    );
    const answer = await new Browser(service).call(startRecovery, "/api/auth/recover", {
      recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
    });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ error: { message: "That recovery code is not valid." } });
  });
});

describe("signing up", () => {
  it("needs an invite code when sign-up is by invite, and each invite makes one workspace", async () => {
    const service = newService({ accounts: { signup: "invite" } });
    const without = await new Browser(service).call(startSignUp, "/api/auth/sign-up", {
      name: "Bob",
      inviteCode: null,
    });
    expect(without.status).toBe(422);

    const invite = service.accounts.issueInviteCode();
    const browser = new Browser(service);
    const options = await optionsOf<PublicKeyCredentialCreationOptionsJSON>(
      await browser.call(startSignUp, "/api/auth/sign-up", { name: "Bob", inviteCode: invite }),
    );
    const done = await browser.call(finishRegistration, "/api/auth/register", {
      response: new SoftPasskey(ORIGIN).create(options),
    });
    expect(done.status).toBe(200);
    const bob = service.accounts.access(browser.session ?? "");
    expect(bob?.workspace.id).not.toBe(service.accounts.store.firstWorkspace().id);

    const reused = await new Browser(service).call(startSignUp, "/api/auth/sign-up", {
      name: "Carol",
      inviteCode: invite,
    });
    expect(reused.status).toBe(403);
  });
});

describe("expiry", () => {
  function clocked() {
    let now = Date.parse("2026-11-17T12:00:00Z");
    const dataDir = mkdtempSync(join(tmpdir(), "mandate-auth-clock-"));
    const accounts = new Accounts(
      readAccountsConfig({ CONSOLE_MODE: "development" }, ORIGIN),
      openDatabase(dataDir),
      { dataDir, log: () => undefined, now: () => new Date(now) },
    );
    return { accounts, advance: (ms: number) => (now += ms) };
  }

  it("refuses a claim code after a day", async () => {
    const { accounts, advance } = clocked();
    const { code } = accounts.issueClaimCode();
    advance(CLAIM_CODE_TTL_MS + 1);
    await expect(
      accounts.startRegistration({ kind: "claim", name: "Alice", claimCode: code }),
    ).rejects.toMatchObject({ status: 403, code: "invalid_code" });
  });

  it("ends a session left idle, and any session at its maximum age", () => {
    const { accounts, advance } = clocked();
    const { code } = accounts.issueClaimCode();
    const member = accounts.store.claim({
      claimHash: codeHash(code),
      memberName: "Alice",
      webauthnUserId: "dXNlcg",
      passkey: {
        credentialId: "cred",
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: [],
        deviceType: "singleDevice",
        backedUp: false,
      },
    })?.member;
    if (!member) throw new Error("not claimed");

    const idle = accounts.openSession(member);
    advance(SESSION_IDLE_MS + 1);
    expect(accounts.access(idle)).toBeNull();

    const busy = accounts.openSession(member);
    const step = SESSION_IDLE_MS / 2;
    for (let elapsed = 0; elapsed + step < SESSION_MAX_AGE_MS; elapsed += step) {
      expect(accounts.access(busy)).not.toBeNull();
      advance(step);
    }
    advance(step);
    expect(accounts.access(busy)).toBeNull();
  });
});

describe("cookies", () => {
  it("are HttpOnly, and over HTTPS Secure with the __Host- prefix", () => {
    const https = readAccountsConfig({ CONSOLE_MODE: "development" }, "https://mandate.example");
    expect(sessionCookie(https, "id")).toMatch(
      /^__Host-mandate_session=id; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(ceremonyCookie(https, "id", 60_000)).toMatch(
      /^__Host-mandate_ceremony=id; Path=\/; Max-Age=60; HttpOnly; SameSite=Strict; Secure$/,
    );
  });
});
