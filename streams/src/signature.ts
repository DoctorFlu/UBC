import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * QuickNode Streams webhook signing, as documented in
 * https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
 *
 * signature = hex(HMAC-SHA256(key = security token, message = nonce + timestamp + body))
 *
 * The body is the uncompressed JSON exactly as received. With gzip enabled on the
 * destination, decompress first and verify over the decompressed bytes.
 */
export const QUICKNODE_SIGNATURE_HEADERS = {
  nonce: "x-qn-nonce",
  timestamp: "x-qn-timestamp",
  signature: "x-qn-signature",
} as const;

/** Default replay window. Deliveries signed longer ago than this, or this far in the future, are rejected. */
export const DEFAULT_MAX_AGE_SECONDS = 300;

/** A Fetch `Headers` object or a Node `IncomingHttpHeaders`-style record. */
export type HeaderBag = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyOptions {
  /** Replay window in seconds; `null` disables the timestamp check. Defaults to 300. */
  readonly maxAgeSeconds?: number | null;
  /** Clock in milliseconds since the epoch, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export type SignatureFailure =
  "missing_header" | "malformed_signature" | "malformed_timestamp" | "signature_mismatch" | "stale_timestamp";

export type SignatureVerification =
  | { readonly ok: true; readonly nonce: string; readonly timestamp: number }
  | { readonly ok: false; readonly reason: SignatureFailure; readonly detail: string };

const SIGNATURE = /^[0-9a-f]{64}$/i;
const UNIX_SECONDS = /^\d{1,12}$/;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    // A repeated signing header is never legitimate; refuse to pick one.
    if (value !== undefined && value.length === 1) return value[0];
    return undefined;
  }
  return undefined;
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}

/** Hex HMAC-SHA256 over `nonce + timestamp + body`, keyed by the Stream's security token. */
export function computeQuickNodeSignature(
  securityToken: string,
  nonce: string,
  timestamp: string,
  rawBody: string | Uint8Array,
): string {
  if (securityToken.length === 0) throw new Error("QuickNode security token is empty");
  return createHmac("sha256", Buffer.from(securityToken, "utf8"))
    .update(Buffer.from(nonce, "utf8"))
    .update(Buffer.from(timestamp, "utf8"))
    .update(toBytes(rawBody))
    .digest("hex");
}

/**
 * Verifies a Streams webhook delivery.
 *
 * Replay protection: the signature binds the nonce and timestamp to the body, so a valid
 * delivery can only be replayed verbatim. The timestamp window bounds how long a captured
 * delivery stays usable; within the window, reject nonces already seen and keep writes
 * idempotent (key logs by transaction hash and log index), because QuickNode itself may
 * deliver a batch more than once after a retry or a pause.
 */
export function verifyQuickNodeSignature(
  headers: HeaderBag,
  rawBody: string | Uint8Array,
  securityToken: string,
  options: VerifyOptions = {},
): SignatureVerification {
  const nonce = readHeader(headers, QUICKNODE_SIGNATURE_HEADERS.nonce);
  const timestamp = readHeader(headers, QUICKNODE_SIGNATURE_HEADERS.timestamp);
  const given = readHeader(headers, QUICKNODE_SIGNATURE_HEADERS.signature);
  if (nonce === undefined || nonce === "" || timestamp === undefined || given === undefined) {
    return {
      ok: false,
      reason: "missing_header",
      detail: "x-qn-nonce, x-qn-timestamp and x-qn-signature are required",
    };
  }
  if (!SIGNATURE.test(given)) {
    return { ok: false, reason: "malformed_signature", detail: "x-qn-signature is not 64 hex characters" };
  }
  if (!UNIX_SECONDS.test(timestamp)) {
    return {
      ok: false,
      reason: "malformed_timestamp",
      detail: "x-qn-timestamp is not a unix time in seconds",
    };
  }

  const expected = Buffer.from(computeQuickNodeSignature(securityToken, nonce, timestamp, rawBody), "hex");
  if (!timingSafeEqual(expected, Buffer.from(given, "hex"))) {
    return { ok: false, reason: "signature_mismatch", detail: "HMAC does not match the body" };
  }

  const signedAt = Number(timestamp);
  const maxAge = options.maxAgeSeconds === undefined ? DEFAULT_MAX_AGE_SECONDS : options.maxAgeSeconds;
  if (maxAge !== null) {
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
    if (Math.abs(nowSeconds - signedAt) > maxAge) {
      return {
        ok: false,
        reason: "stale_timestamp",
        detail: `delivery age ${nowSeconds - signedAt}s is outside the ${maxAge}s window`,
      };
    }
  }

  return { ok: true, nonce, timestamp: signedAt };
}
