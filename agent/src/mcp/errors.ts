/**
 * Stable codes for real failures. A policy denial is never one of these: it is a verdict
 * (`rejected`, `held`, `unavailable`) returned as a normal result.
 */
export const TOOL_ERROR_CODES = {
  /** The arguments do not match the tool's input schema. The agent should fix them. */
  INVALID_INPUT: { retryable: false },
  /** A dependency (chain RPC, Gemini, console) could not be reached. Retrying later may work. */
  UPSTREAM_UNAVAILABLE: { retryable: true },
  /** A dependency answered with something unusable. */
  UPSTREAM_ERROR: { retryable: false },
  /** The tool did not finish within its time budget. */
  TIMEOUT: { retryable: true },
  /** A bug or unexpected state on the server. Details are in the server log under the request id. */
  INTERNAL: { retryable: false },
} as const satisfies Record<string, { retryable: boolean }>;

export type ToolErrorCode = keyof typeof TOOL_ERROR_CODES;

/**
 * Throw from a tool handler to report a real error. `message` is shown to the model, so it must
 * be short, actionable, and free of secrets, stack traces and raw upstream payloads.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolError";
    this.code = code;
  }

  get retryable(): boolean {
    return TOOL_ERROR_CODES[this.code].retryable;
  }
}
