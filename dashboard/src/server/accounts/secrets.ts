import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AGENT_TOKEN_PREFIX } from "@mandate/shared";

/**
 * Ids, tokens and codes. Every secret is made from the operating system's random source and is high
 * enough in entropy that a plain SHA-256 is a safe way to store it (docs/accounts.md, "Tokens and codes").
 */

/** Crockford's base32 alphabet, lower case: no i, l, o or u, so ids and codes read unambiguously. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** A record id such as `wsp_` and 26 base32 characters (128 random bits). Not a secret. */
export function newId(prefix: "wsp" | "mbr" | "mnd" | "agt" | "tok" | "oac" | "stp"): string {
  return `${prefix}_${base32(randomBytes(16))}`;
}

/** An agent token: `mdt_` and 43 base64url characters (256 bits). Shown once, stored as its hash. */
export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A session or ceremony id for a cookie (256 bits). Stored as its hash. */
export function newOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A code a person types or pastes: 24 base32 characters (120 bits) in groups of four, upper case, such as
 * `7K3M-...`. Claim, invite and recovery codes.
 */
export function newHumanCode(): string {
  return base32(randomBytes(15)).toUpperCase().match(/.{4}/g)?.join("-") ?? "";
}

/**
 * A typed code as the store hashes it: case, spaces and dashes ignored, and the letters people confuse
 * with digits (I and L for 1, O for 0) read as Crockford's base32 reads them. Null when it cannot be one.
 */
export function normalizeHumanCode(input: string): string | null {
  const code = input.toLowerCase().replace(/[\s-]/g, "").replace(/[il]/g, "1").replace(/o/g, "0");
  return /^[0-9a-hjkmnp-tv-z]{24}$/.test(code) ? code : null;
}

/** The SHA-256 of a secret, as 64 lowercase hex digits: what the store keeps. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of two secrets of any length: both are hashed to 32 bytes first. */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}
