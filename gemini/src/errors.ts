/** Why a Gemini call failed. Callers branch on `code`, never on the message text. */
export type GeminiErrorCode =
  /** The resource does not exist (HTTP 404). Not retried. */
  | "not_found"
  /** Still rate limited (HTTP 429) after every retry. */
  | "rate_limited"
  /** Any other non-success HTTP status, after retries for 5xx. */
  | "http"
  /** The request did not complete within the timeout, after retries. */
  | "timeout"
  /** The request failed before a response arrived (DNS, TLS, connection reset), after retries. */
  | "network"
  /** The response was not JSON or did not match the expected shape. Not retried. */
  | "invalid_response"
  /** No ladder matches the requested asset and expiry. */
  | "no_ladder"
  /** The caller passed an argument the client cannot use. */
  | "invalid_argument"
  /**
   * Gemini answered, but its spot market is not trading normally: the spread is too wide to take its mid
   * and the last trade is too old to take instead (`getSpot`). Nothing is planned on such a price.
   */
  | "spot_unavailable";

export class GeminiError extends Error {
  override readonly name = "GeminiError";
  readonly code: GeminiErrorCode;
  /** HTTP status when the failure came from a response. */
  readonly status: number | undefined;
  /** The request path, without the base URL. */
  readonly path: string | undefined;
  /** Number of attempts made, including the first. */
  readonly attempts: number | undefined;

  constructor(
    code: GeminiErrorCode,
    message: string,
    details: { status?: number; path?: string; attempts?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.status = details.status;
    this.path = details.path;
    this.attempts = details.attempts;
  }
}

export function isGeminiError(error: unknown, code?: GeminiErrorCode): error is GeminiError {
  return error instanceof GeminiError && (code === undefined || error.code === code);
}
