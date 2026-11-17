import "server-only";

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

import { safeNext } from "@/lib/accounts/next";

import { AccountError, CEREMONY_TTL_MS } from "../accounts/accounts";
import type { RateLimit } from "../accounts/rate-limit";
import { clientKey } from "../accounts/rate-limit";
import type { ConsoleService } from "../console-service";
import { apiError, describeIssues, json, readBody } from "./responses";
import {
  ceremonyCookie,
  ceremonyCookieName,
  checkOrigin,
  clearedCeremonyCookie,
  clearedSessionCookie,
  consoleRoute,
  describe,
  privateHeaders,
  readCookie,
  sessionCookie,
  sessionIdOf,
} from "./session";

/**
 * The account routes under /api/auth: passkey sign-up, claim, recovery and sign-in, sign-out, and the
 * checks the reverse proxy asks before it lets a request through (docs/accounts.md). They are public:
 * each one is either the way to a session or answers only about the caller's own.
 */

type Handler = (request: Request, service: ConsoleService) => Promise<Response> | Response;

/** The Origin check for writes, AccountError and schema failures as plain answers, and private headers. */
function authRoute(handler: Handler) {
  return async (request: Request, service: ConsoleService): Promise<Response> => {
    const crossSite = checkOrigin(request, service.config.accounts);
    if (crossSite) return privateHeaders(crossSite);
    try {
      return privateHeaders(await handler(request, service));
    } catch (error) {
      if (AccountError.is(error)) return privateHeaders(apiError(error.status, error.code, error.message));
      if (error instanceof z.ZodError)
        return privateHeaders(apiError(422, "invalid_body", describeIssues(error)));
      console.error(
        `[console] ${request.method} ${new URL(request.url).pathname} failed: ${describe(error)}`,
      );
      return privateHeaders(apiError(500, "internal_error", "Something went wrong. Try again."));
    }
  };
}

/** Takes one attempt from a limit, or the 429 to answer with. */
function limit(request: Request, service: ConsoleService, rate: RateLimit): Response | null {
  const wait = rate.take(clientKey(request, service.config.accounts.trustProxy));
  if (wait === 0) return null;
  const response = apiError(429, "rate_limited", `Too many attempts. Try again in ${String(wait)} s.`);
  response.headers.set("Retry-After", String(wait));
  return response;
}

/** Ceremony options, with the cookie that ties the answer to this browser. */
function ceremonyResponse(service: ConsoleService, ceremonyId: string, options: unknown): Response {
  const response = json({ options });
  response.headers.append("Set-Cookie", ceremonyCookie(service.config.accounts, ceremonyId, CEREMONY_TTL_MS));
  return response;
}

// ------------------------------------------------------------------ starting a registration

const signUpSchema = z.strictObject({
  name: z.string().max(200),
  inviteCode: z.string().max(200).nullable(),
});
const claimSchema = z.strictObject({ name: z.string().max(200), claimCode: z.string().max(200) });
const recoverSchema = z.strictObject({ recoveryCode: z.string().max(200) });

/** POST /api/auth/sign-up: a new workspace, with an invite code unless sign-up is open. */
export const startSignUp = authRoute(async (request, service) => {
  const denied = limit(request, service, service.accounts.limits.ceremonies);
  if (denied) return denied;
  const body = await readBody(request, signUpSchema);
  if (!body.ok) return body.response;
  if (service.config.accounts.signup === "invite") {
    const slow = limit(request, service, service.accounts.limits.codes);
    if (slow) return slow;
  }
  const started = await service.accounts.startRegistration({ kind: "sign-up", ...body.data });
  return ceremonyResponse(service, started.ceremonyId, started.options);
});

/** POST /api/auth/claim: the first member of the workspace the operator's claim code names. */
export const startClaim = authRoute(async (request, service) => {
  const denied =
    limit(request, service, service.accounts.limits.ceremonies) ??
    limit(request, service, service.accounts.limits.codes);
  if (denied) return denied;
  const body = await readBody(request, claimSchema);
  if (!body.ok) return body.response;
  const started = await service.accounts.startRegistration({ kind: "claim", ...body.data });
  return ceremonyResponse(service, started.ceremonyId, started.options);
});

/** POST /api/auth/recover: a new passkey for the member whose recovery code this is. */
export const startRecovery = authRoute(async (request, service) => {
  const denied =
    limit(request, service, service.accounts.limits.ceremonies) ??
    limit(request, service, service.accounts.limits.codes);
  if (denied) return denied;
  const body = await readBody(request, recoverSchema);
  if (!body.ok) return body.response;
  const started = await service.accounts.startRegistration({ kind: "recover", ...body.data });
  return ceremonyResponse(service, started.ceremonyId, started.options);
});

/** POST /api/console/passkeys: another passkey for the signed-in member. */
export const startAddPasskey = consoleRoute(async (request, service, { access }) => {
  const denied = limit(request, service, service.accounts.limits.ceremonies);
  if (denied) return denied;
  const started = await service.accounts.startRegistration({ kind: "add", member: access.member });
  return ceremonyResponse(service, started.ceremonyId, started.options);
});

// ------------------------------------------------------------------ finishing a registration

const credentialSchema = z.strictObject({ response: z.looseObject({ id: z.string().max(1024) }) });

/**
 * POST /api/auth/register: the browser's new passkey, for whichever registration this browser started.
 * Sign-up, claim and recovery end signed in, with a new session and a new recovery code shown once.
 */
export const finishRegistration = authRoute(async (request, service) => {
  const denied = limit(request, service, service.accounts.limits.ceremonies);
  if (denied) return denied;
  const body = await readBody(request, credentialSchema);
  if (!body.ok) return body.response;
  const config = service.config.accounts;
  const signedIn = service.accounts.access(sessionIdOf(request, config));
  const outcome = await service.accounts.finishRegistration(
    readCookie(request, ceremonyCookieName(config)),
    body.data.response as unknown as RegistrationResponseJSON,
    signedIn?.member ?? null,
  );
  if (outcome.kind === "passkey-added") {
    const response = json({ status: "passkey-added" });
    response.headers.append("Set-Cookie", clearedCeremonyCookie(config));
    return response;
  }
  return signedInResponse(request, service, outcome.member, { recoveryCode: outcome.recoveryCode });
});

/** A fresh session for the member: any session the browser had is closed, never reused (no fixation). */
function signedInResponse(
  request: Request,
  service: ConsoleService,
  member: Parameters<ConsoleService["accounts"]["openSession"]>[0],
  body: Record<string, unknown>,
): Response {
  const config = service.config.accounts;
  service.accounts.closeSession(sessionIdOf(request, config));
  const sessionId = service.accounts.openSession(member);
  const response = json({ status: "signed-in", ...body });
  response.headers.append("Set-Cookie", sessionCookie(config, sessionId));
  response.headers.append("Set-Cookie", clearedCeremonyCookie(config));
  return response;
}

// ------------------------------------------------------------------ sign-in and sign-out

/** POST /api/auth/sign-in: a challenge any of this site's passkeys can answer. */
export const startSignIn = authRoute(async (request, service) => {
  const denied = limit(request, service, service.accounts.limits.ceremonies);
  if (denied) return denied;
  const started = await service.accounts.startAuthentication();
  return ceremonyResponse(service, started.ceremonyId, started.options);
});

/** POST /api/auth/sign-in/verify: the passkey's answer; a new session when it checks out. */
export const finishSignIn = authRoute(async (request, service) => {
  const denied = limit(request, service, service.accounts.limits.ceremonies);
  if (denied) return denied;
  const body = await readBody(request, credentialSchema);
  if (!body.ok) return body.response;
  const member = await service.accounts.finishAuthentication(
    readCookie(request, ceremonyCookieName(service.config.accounts)),
    body.data.response as unknown as AuthenticationResponseJSON,
  );
  return signedInResponse(request, service, member, {});
});

/** POST /api/auth/sign-out: ends this browser's session. Answers the same whether there was one. */
export const signOut = authRoute((request, service) => {
  const config = service.config.accounts;
  service.accounts.closeSession(sessionIdOf(request, config));
  const response = json({ status: "signed-out" });
  response.headers.append("Set-Cookie", clearedSessionCookie(config));
  return response;
});

/** GET /api/auth/session: who is signed in, for the account menu; 401 when nobody is. */
export const currentSession = authRoute((request, service) => {
  const access = service.accounts.access(sessionIdOf(request, service.config.accounts));
  if (!access) return apiError(401, "unauthenticated", "Nobody is signed in.");
  return json({
    member: { name: access.member.name, role: access.member.role },
    workspace: { name: access.workspace.name },
  });
});

// ------------------------------------------------------------------ the reverse proxy's checks

/** Paths a person opens in the browser get the sign-in page; anything else gets a 401. */
function isNavigation(request: Request, uri: string): boolean {
  const method = (request.headers.get("x-forwarded-method") ?? "GET").toUpperCase();
  const accept = request.headers.get("accept") ?? "";
  return method === "GET" && !uri.startsWith("/api/") && accept.includes("text/html");
}

/**
 * GET /api/auth/forward: the reverse proxy's `forward_auth` check for every path that is not public.
 * 204 lets the request through; otherwise a navigation is sent to the sign-in page and anything else gets
 * a 401. The proxy names the original request in `X-Forwarded-Method` and `X-Forwarded-Uri`.
 */
export const forwardAuth = authRoute((request, service) => {
  const access = service.accounts.access(sessionIdOf(request, service.config.accounts));
  if (access) return new Response(null, { status: 204 });
  const uri = request.headers.get("x-forwarded-uri") ?? "/";
  if (isNavigation(request, uri)) {
    const next = safeNext(uri);
    const location = next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`;
    return new Response(null, { status: 303, headers: { Location: location } });
  }
  return apiError(401, "unauthenticated", "Sign in to use the console.");
});

/**
 * GET /api/auth/forward/rpc: the stricter check for the demo chain's RPC, whose owner key is public: only
 * a member of the workspace that holds the server's own mandate may reach it.
 */
export const forwardRpcAuth = authRoute((request, service) => {
  const access = service.accounts.access(sessionIdOf(request, service.config.accounts));
  if (!access) return apiError(401, "unauthenticated", "Sign in to use the console.");
  const holds = service.accounts.store
    .mandates(access.workspace.id)
    .some((mandate) => mandate.deployment === "env");
  if (!holds) return apiError(403, "forbidden", "This workspace has no access to the demo chain.");
  return new Response(null, { status: 204 });
});
