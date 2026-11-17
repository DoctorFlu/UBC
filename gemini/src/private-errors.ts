/**
 * Why a signed (private) Gemini call failed. Callers branch on `kind`, never on the message text.
 *
 * The kinds that matter most are the ones that say whether Gemini acted on the request:
 * - Gemini answered with a refusal (`auth`, `nonce`, `terms`, `account`, `rate_limited`, `rejected`): it
 *   did not act on it. An order sent and refused this way was not placed.
 * - No usable answer (`unavailable`, `timeout`, `network`, `invalid_response`, `redirected`): it may or
 *   may not have acted. An order sent and failed this way may exist; it must be looked up, never sent
 *   again blindly.
 */
export type GeminiPrivateErrorKind =
  /** The key, its signature or its role was refused (unknown key, wrong secret, missing role). */
  | "auth"
  /** The nonce was refused: outside Gemini's time window, or not higher than the last one. */
  | "nonce"
  /** The account has not accepted the latest Prediction Markets terms. Accept them in Gemini's site. */
  | "terms"
  /** The account may not trade prediction markets, or may only sell. */
  | "account"
  /** Too many requests (HTTP 429). */
  | "rate_limited"
  /** The request itself was refused (an invalid order, insufficient funds, an unknown order id). */
  | "rejected"
  /** Gemini answered with a server error (HTTP 5xx), including "temporarily unavailable". */
  | "unavailable"
  /** No answer within the time limit. */
  | "timeout"
  /** The request failed before an answer arrived (DNS, TLS, connection reset). */
  | "network"
  /** A success status, but a body that is not JSON or not the documented shape. */
  | "invalid_response"
  /**
   * The answer was a redirect (HTTP 3xx). It is never followed, because the signed headers would travel to
   * whatever host it names. Gemini's API does not redirect, so its meaning is unknown: an order may exist.
   */
  | "redirected"
  /** The caller passed something the client refuses to send. Nothing was sent. */
  | "invalid_argument";

/** Kinds after which Gemini may have acted on the request: an order may exist. */
const UNKNOWN_OUTCOME: ReadonlySet<GeminiPrivateErrorKind> = new Set([
  "unavailable",
  "timeout",
  "network",
  "invalid_response",
  "redirected",
]);

export class GeminiPrivateError extends Error {
  override readonly name = "GeminiPrivateError";
  readonly kind: GeminiPrivateErrorKind;
  /** HTTP status when Gemini answered. */
  readonly status: number | undefined;
  /** Gemini's own error code (`reason` or `error` in its body), for example `InvalidApiKey`. */
  readonly reason: string | undefined;
  /** The request path, without the host. */
  readonly path: string | undefined;

  constructor(
    kind: GeminiPrivateErrorKind,
    message: string,
    details: { status?: number; reason?: string; path?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.status = details.status;
    this.reason = details.reason;
    this.path = details.path;
  }

  /** True when Gemini may have acted on the request despite the failure. */
  get outcomeUnknown(): boolean {
    return UNKNOWN_OUTCOME.has(this.kind);
  }
}

export function isGeminiPrivateError(
  error: unknown,
  kind?: GeminiPrivateErrorKind,
): error is GeminiPrivateError {
  return error instanceof GeminiPrivateError && (kind === undefined || error.kind === kind);
}

/** Gemini's auth-layer reasons that mean the nonce, not the key, was refused. */
const NONCE_REASONS = new Set(["InvalidNonce", "MissingNonce", "NonceTooOld", "NonceAlreadyUsed"]);

/**
 * Classifies a non-success answer. Gemini uses two body shapes: the auth layer's
 * `{ result: "error", reason, message }` and Prediction Markets' `{ error, message }` (or
 * `{ error, code }` for a blocked account).
 */
export function classifyAnswer(
  status: number,
  body: unknown,
): { kind: GeminiPrivateErrorKind; reason: string | undefined; message: string | undefined } {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const authReason = record.result === "error" ? text(record.reason) : undefined;
  const pmError = text(record.error);
  const pmCode = text(record.code);
  const reason = authReason ?? pmCode ?? pmError;
  const message = text(record.message);

  if (status === 429) return { kind: "rate_limited", reason, message };
  if (status >= 500) return { kind: "unavailable", reason, message };
  if (pmError === "TERMS_NOT_ACCEPTED") return { kind: "terms", reason, message };
  if (pmCode === "ACCOUNT_GROUP_BLOCKED" || pmError === "ACCOUNT_RESTRICTED_SELL_ONLY") {
    return { kind: "account", reason, message };
  }
  if (authReason !== undefined && (NONCE_REASONS.has(authReason) || status === 409)) {
    return { kind: "nonce", reason, message };
  }
  if (status === 401 || status === 403 || (reason !== undefined && AUTH_REASONS.has(reason))) {
    return { kind: "auth", reason, message };
  }
  return { kind: "rejected", reason, message };
}

/** Auth-layer reasons from Gemini's API key documentation, refused with HTTP 400 or 403. */
const AUTH_REASONS = new Set([
  "MissingApikeyHeader",
  "MissingPayloadHeader",
  "MissingSignatureHeader",
  "InvalidSignature",
  "AmbiguousAuthentication",
  "InvalidApiKey",
  "MissingRole",
  "MissingAccounts",
  "InvalidAccountName",
]);
