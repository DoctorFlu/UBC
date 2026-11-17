import "server-only";

import { type Access, AccountError } from "../accounts/accounts";
import type { Mandate } from "../accounts/store";
import { SESSION_MAX_AGE_MS } from "../accounts/store";
import type { AccountsConfig } from "../config";
import type { ConsoleService } from "../console-service";
import { apiError } from "./responses";

/**
 * Sessions on the wire: the cookie, the Origin check every write passes, and the wrapper every console
 * route goes through (docs/accounts.md, "Sessions" and "Cross-site requests").
 */

/**
 * The session cookie's name. Over HTTPS it carries the `__Host-` prefix, so the browser only accepts it
 * Secure, from this exact host, for path `/`. Plain-HTTP development on localhost cannot use the prefix.
 */
export function sessionCookieName(config: Pick<AccountsConfig, "origin">): string {
  return secure(config) ? "__Host-mandate_session" : "mandate_session";
}

/** The cookie that ties a passkey prompt to the browser that asked for it. */
export function ceremonyCookieName(config: Pick<AccountsConfig, "origin">): string {
  return secure(config) ? "__Host-mandate_ceremony" : "mandate_ceremony";
}

function secure(config: Pick<AccountsConfig, "origin">): boolean {
  return config.origin.startsWith("https:");
}

/** Every session cookie name, for code that must recognise one before it knows the settings. */
export const SESSION_COOKIE_NAMES = ["__Host-mandate_session", "mandate_session"] as const;

function cookieAttributes(
  config: Pick<AccountsConfig, "origin">,
  maxAgeSeconds: number,
  sameSite: string,
): string {
  return [`Path=/`, `Max-Age=${String(maxAgeSeconds)}`, "HttpOnly", `SameSite=${sameSite}`]
    .concat(secure(config) ? ["Secure"] : [])
    .join("; ");
}

/** `Set-Cookie` for a new session. Lax, so a link from elsewhere still opens the console signed in. */
export function sessionCookie(config: Pick<AccountsConfig, "origin">, sessionId: string): string {
  return `${sessionCookieName(config)}=${sessionId}; ${cookieAttributes(config, SESSION_MAX_AGE_MS / 1000, "Lax")}`;
}

/** `Set-Cookie` that removes the session cookie. */
export function clearedSessionCookie(config: Pick<AccountsConfig, "origin">): string {
  return `${sessionCookieName(config)}=; ${cookieAttributes(config, 0, "Lax")}`;
}

export function ceremonyCookie(
  config: Pick<AccountsConfig, "origin">,
  ceremonyId: string,
  maxAgeMs: number,
): string {
  return `${ceremonyCookieName(config)}=${ceremonyId}; ${cookieAttributes(config, Math.floor(maxAgeMs / 1000), "Strict")}`;
}

export function clearedCeremonyCookie(config: Pick<AccountsConfig, "origin">): string {
  return `${ceremonyCookieName(config)}=; ${cookieAttributes(config, 0, "Strict")}`;
}

/** A cookie's value from a request, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** The session id a request carries, or null. */
export function sessionIdOf(request: Request, config: Pick<AccountsConfig, "origin">): string | null {
  return readCookie(request, sessionCookieName(config));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses a write that does not come from the console's own pages: its `Origin` must be the console's.
 * Browsers send `Origin` with every POST, PUT, PATCH and DELETE, and a page on another site cannot forge
 * it. Returns an error response, or null when the request may proceed.
 */
export function checkOrigin(request: Request, config: Pick<AccountsConfig, "origin">): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = request.headers.get("origin");
  if (origin === config.origin) return null;
  return apiError(403, "cross_origin", "This request must come from the console's own pages.");
}

/** Headers that tell the browser and every cache that this answer is one person's. */
export function privateHeaders(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.append("Vary", "Cookie");
  return response;
}

/** A signed-in request's member and workspace, and the one mandate it acts on. */
export interface ConsoleScope {
  access: Access;
  mandate: Mandate;
}

export type ConsoleHandler = (
  request: Request,
  service: ConsoleService,
  scope: ConsoleScope,
  params: Record<string, string>,
) => Promise<Response> | Response;

/**
 * The scope of a console request, or the error to answer with: 401 without a live session, 404 when the
 * `mandate` query names a mandate outside the session's workspace (the same answer as one that does not
 * exist, so a guess learns nothing).
 */
export function scopeOf(request: Request, service: ConsoleService): ConsoleScope | Response {
  const access = service.accounts.access(sessionIdOf(request, service.config.accounts));
  if (!access) return apiError(401, "unauthenticated", "Sign in to use the console.");
  const requested = new URL(request.url).searchParams.get("mandate");
  const mandate = service.accounts.mandateFor(access, requested);
  if (!mandate) return apiError(404, "not_found", "This workspace has no such mandate.");
  return { access, mandate };
}

/**
 * Wraps a console route: the Origin check for writes, the session, the mandate, private caching headers,
 * and a uniform 500 that says nothing about the failure. Every route under /api/console goes through it
 * (a test checks).
 */
export function consoleRoute(handler: ConsoleHandler) {
  return async (
    request: Request,
    service: ConsoleService,
    params: Record<string, string> = {},
  ): Promise<Response> => {
    const crossSite = checkOrigin(request, service.config.accounts);
    if (crossSite) return crossSite;
    const scope = scopeOf(request, service);
    if (scope instanceof Response) return privateHeaders(scope);
    try {
      return privateHeaders(await handler(request, service, scope, params));
    } catch (error) {
      if (error instanceof AccountError)
        return privateHeaders(apiError(error.status, error.code, error.message));
      console.error(
        `[console] ${request.method} ${new URL(request.url).pathname} failed: ${describe(error)}`,
      );
      return privateHeaders(
        apiError(500, "internal_error", "The console failed to handle this request. Try again."),
      );
    }
  };
}

/** An error's class and first line, never its properties: a request's secrets can sit in those. */
export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.split("\n")[0] ?? ""}`;
  return typeof error;
}
