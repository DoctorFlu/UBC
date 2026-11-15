import { createHash, timingSafeEqual } from "node:crypto";
import type { Secret } from "../secret";

/**
 * Compares two strings in time that does not depend on where they differ or on their lengths:
 * both sides are hashed to fixed-size digests first, then compared with `timingSafeEqual`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** The token from an `Authorization: Bearer <token>` header, or undefined if absent or malformed. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return match?.[1];
}

/** Whether the request's Authorization header carries the expected bearer token. */
export function isAuthorized(header: string | undefined, expected: Secret): boolean {
  const presented = bearerToken(header);
  // Compare even when the header is missing so the response time does not reveal which case it was.
  const ok = constantTimeEqual(presented ?? "", expected.reveal());
  return presented !== undefined && ok;
}
