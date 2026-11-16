/**
 * GET with rate limiting, a per-attempt timeout, retries with exponential backoff and full
 * jitter on 429, 5xx, timeouts and network failures, and schema validation of the body.
 * Only unauthenticated GET requests exist in this package.
 */
import type { z } from "zod";
import { GeminiError } from "./errors";
import type { TokenBucket } from "./rate-limiter";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  fetch: FetchLike;
  limiter: TokenBucket;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  timeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Called before each request is sent, retries included. */
  onRequest?: (path: string) => void;
}

type Outcome =
  | { kind: "ok"; body: string }
  | { kind: "retry"; error: GeminiError; retryAfterMs: number | null }
  | { kind: "fail"; error: GeminiError };

export async function getJson<S extends z.ZodType>(
  options: HttpOptions,
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const attempts = options.maxRetries + 1;
  let lastError: GeminiError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await options.limiter.acquire();
    options.onRequest?.(path);
    const outcome = await attemptOnce(options, path, attempt);
    if (outcome.kind === "ok") return parseBody(outcome.body, schema, path, attempt);
    if (outcome.kind === "fail") throw outcome.error;
    lastError = outcome.error;
    if (attempt < attempts) {
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.floor(options.random() * ceiling);
      await options.sleep(Math.max(jittered, outcome.retryAfterMs ?? 0));
    }
  }
  throw lastError ?? new GeminiError("network", `GET ${path} failed`, { path, attempts });
}

async function attemptOnce(options: HttpOptions, path: string, attempt: number): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await options.fetch(options.baseUrl + path, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.ok) return { kind: "ok", body };
    const detail = `GET ${path} returned HTTP ${response.status}: ${body.slice(0, 200)}`;
    const details = { status: response.status, path, attempts: attempt };
    if (response.status === 404)
      return { kind: "fail", error: new GeminiError("not_found", detail, details) };
    if (response.status === 429) {
      return {
        kind: "retry",
        error: new GeminiError("rate_limited", detail, details),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    const error = new GeminiError("http", detail, details);
    return response.status >= 500 ? { kind: "retry", error, retryAfterMs: null } : { kind: "fail", error };
  } catch (cause) {
    if (controller.signal.aborted) {
      const error = new GeminiError("timeout", `GET ${path} timed out after ${options.timeoutMs} ms`, {
        path,
        attempts: attempt,
        cause,
      });
      return { kind: "retry", error, retryAfterMs: null };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    const error = new GeminiError("network", `GET ${path} failed: ${message}`, {
      path,
      attempts: attempt,
      cause,
    });
    return { kind: "retry", error, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody<S extends z.ZodType>(body: string, schema: S, path: string, attempt: number): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new GeminiError("invalid_response", `GET ${path} did not return JSON`, {
      path,
      attempts: attempt,
      cause,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new GeminiError("invalid_response", `GET ${path} returned an unexpected shape${where}`, {
      path,
      attempts: attempt,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Retry-After is either seconds or an HTTP date. Capped at one minute. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  return null;
}
