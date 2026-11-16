import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { type ConsoleError, consoleErrorSchema } from "@mandate/shared";
import type { z } from "zod";

/** JSON with the headers every API answer carries: no caching, no sniffing. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** An error in the wire contract's shape: a stable code and one sentence a person can act on. */
export function apiError(status: number, code: string, message: string): Response {
  const body: ConsoleError = consoleErrorSchema.parse({ error: { code, message } });
  return json(body, status);
}

/** The first issue of a schema failure, as "path: message". */
export function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The request does not match its schema.";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads a JSON body and validates it. Invalid JSON and schema failures are both 422 `invalid_body`. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: apiError(422, "invalid_body", "The body is not valid JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: apiError(422, "invalid_body", describeIssues(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Compares a presented secret with the expected one in constant time. Both are hashed first, so neither
 * the content nor the length of the expected secret leaks through timing.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Checks `Authorization: Bearer <CONSOLE_SERVICE_TOKEN>`. Returns an error response, or null when the
 * caller may proceed.
 */
export function checkServiceToken(request: Request, token: string | null): Response | null {
  if (token === null) {
    return apiError(
      503,
      "not_configured",
      "The console has no CONSOLE_SERVICE_TOKEN, so it accepts no agent requests. Set it on both sides.",
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1] || !secretsMatch(match[1], token)) {
    return apiError(401, "unauthorized", "Send the console service token as a Bearer token.");
  }
  return null;
}
