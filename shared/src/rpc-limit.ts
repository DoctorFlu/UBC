import {
  type EIP1193RequestFn,
  type HttpTransport,
  type HttpTransportConfig,
  BaseError,
  HttpRequestError,
  TimeoutError,
  http,
} from "viem";

/**
 * Rate limits of a JSON-RPC endpoint. Arc's public RPC refuses with HTTP 429 when one address asks too
 * often, which viem reports as `LimitExceededRpcError` (-32005, "Request exceeds defined limit"). Every
 * client of one endpoint in a process shares one gate: after a refusal nobody in the process asks again
 * until the endpoint's `Retry-After` (or a growing, jittered backoff) has passed, so pollers, tool calls
 * and receipt waits back off together instead of each hammering on its own.
 */

/** First wait after a refusal that names none; it doubles with each further refusal in a row. */
export const RATE_LIMIT_FIRST_BACKOFF_MS = 2_000;
/** Longest wait after a refusal, whatever the streak or the endpoint's `Retry-After`. */
export const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

/** JSON-RPC codes that mean "too many requests": the standard -32005, a bare 429, QuickNode's -32007. */
const RATE_LIMIT_CODES = new Set([-32005, 429, -32007]);

/** Raised without sending when the process's gate for an endpoint is closed for longer than a caller waits. */
export class RpcRateLimitedError extends BaseError {
  readonly code = -32005;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`The RPC is rate-limiting us; retrying in ${formatWait(retryAfterMs)}.`, {
      name: "RpcRateLimitedError",
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RateLimit {
  /** How long the endpoint asked us to wait, when it said; null when it did not. */
  retryAfterMs: number | null;
}

/** The rate-limit refusal inside `error` (an HTTP 429 or a -32005 answer, wrapped or not), or null. */
export function rateLimitOf(error: unknown): RateLimit | null {
  let limited = false;
  let retryAfterMs: number | null = null;
  for (let e: unknown = error, depth = 0; e !== null && e !== undefined && depth < 10; depth++) {
    if (e instanceof RpcRateLimitedError) return { retryAfterMs: e.retryAfterMs };
    if (typeof e !== "object") break;
    const { code, status, headers, cause } = e as {
      code?: unknown;
      status?: unknown;
      headers?: unknown;
      cause?: unknown;
    };
    if (typeof code === "number" && RATE_LIMIT_CODES.has(code)) limited = true;
    if (status === 429) limited = true;
    if (headers instanceof Headers) retryAfterMs ??= parseRetryAfter(headers.get("retry-after"));
    e = cause;
  }
  return limited ? { retryAfterMs } : null;
}

/** `Retry-After` in milliseconds: delta seconds or an HTTP date. Null when absent, past or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at) || at <= now) return null;
  return at - now;
}

/** "1 s", "12 s", "1 min": a wait as an owner reads it. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  return seconds < 120 ? `${String(seconds)} s` : `${String(Math.round(seconds / 60))} min`;
}

export interface RpcGateOptions {
  now?: () => number;
  /** Uniform in [0, 1). */
  random?: () => number;
}

/** When an endpoint may be asked again. One per endpoint per process (`rpcGate`); tests make their own. */
export class RpcGate {
  #notBefore = 0;
  #streak = 0;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(options: RpcGateOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  /** Milliseconds until the endpoint may be asked again; 0 when it may be asked now. */
  remainingMs(): number {
    return Math.max(0, this.#notBefore - this.#now());
  }

  /** Refusals in a row since the last answer. */
  get streak(): number {
    return this.#streak;
  }

  /**
   * Notes a refusal and closes the gate: for the endpoint's `Retry-After` when it gave one, else for a
   * backoff that doubles with the streak. Either is jittered upwards by up to a fifth, so processes that
   * share an address do not all come back in the same instant. Returns how long the gate is closed.
   */
  refused(retryAfterMs: number | null): number {
    // Refusals of requests sent together (a batch, parallel reads) are one episode, not a streak.
    if (this.remainingMs() === 0) this.#streak += 1;
    const backoff = Math.min(
      RATE_LIMIT_MAX_BACKOFF_MS,
      RATE_LIMIT_FIRST_BACKOFF_MS * 2 ** Math.min(this.#streak - 1, 10),
    );
    const base = Math.min(RATE_LIMIT_MAX_BACKOFF_MS, retryAfterMs ?? backoff);
    const delay = Math.round(base * (1 + this.#random() / 5));
    // A refusal that arrives late (a request sent before the gate closed) never shortens the wait.
    this.#notBefore = Math.max(this.#notBefore, this.#now() + delay);
    return this.remainingMs();
  }

  /** Notes an answer: the next refusal starts the backoff again from the first step. */
  answered(): void {
    this.#streak = 0;
  }
}

const gates = new Map<string, RpcGate>();

/** The process's gate for `url`: every client of one endpoint shares it. */
export function rpcGate(url: string): RpcGate {
  let gate = gates.get(url);
  if (!gate) {
    gate = new RpcGate();
    gates.set(url, gate);
  }
  return gate;
}

/** Methods that send a transaction: retried only after a rate-limit refusal, which proves it was not taken. */
const WRITE_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);

export interface PoliteHttpConfig extends Omit<HttpTransportConfig, "retryCount" | "retryDelay"> {
  /**
   * How many times one request is sent again: after a rate-limit refusal once the gate opens (if that is
   * within `maxWaitMs`), and, for reads only, after a timeout, a network failure or a 5xx. Defaults to 0:
   * a poller retries on its own schedule.
   */
  retryCount?: number;
  /**
   * Longest a request waits for a closed gate before it fails at once with `RpcRateLimitedError`
   * (without being sent). Defaults to 0: never wait, fail fast, and let the caller say when it retries.
   */
  maxWaitMs?: number;
  /** The gate to use; the process's gate for the URL by default. */
  gate?: RpcGate;
}

/**
 * viem's `http` transport behind the process's rate-limit gate for `url`. A request is not sent while
 * the gate is closed; a refusal closes it for every client of that endpoint in the process. viem's own
 * retries are off: they would resend at once, per client, which is what the endpoint refused.
 */
export function politeHttp(url: string, config: PoliteHttpConfig = {}): HttpTransport {
  const { retryCount = 0, maxWaitMs = 0, gate = rpcGate(url), ...rest } = config;
  const inner = http(url, { ...rest, retryCount: 0 });
  const transport = ((params: Parameters<HttpTransport>[0]) => {
    const built = inner(params);
    const send = built.request;
    const request = (async (args, options) => {
      const write = WRITE_METHODS.has(args.method);
      for (let attempt = 0; ; attempt++) {
        const wait = gate.remainingMs();
        if (wait > 0) {
          if (wait > maxWaitMs) throw new RpcRateLimitedError(wait);
          await delay(wait, options?.signal ?? undefined);
        }
        try {
          const result: unknown = await send(args, options);
          gate.answered();
          return result;
        } catch (error) {
          const limit = rateLimitOf(error);
          if (limit) gate.refused(limit.retryAfterMs);
          if (attempt >= retryCount || options?.signal?.aborted) throw error;
          if (limit) continue;
          if (write || !transient(error)) throw error;
          await delay(150 * 2 ** attempt, options?.signal ?? undefined);
        }
      }
    }) as EIP1193RequestFn;
    return { ...built, request };
  }) as HttpTransport;
  return transport;
}

/** A failure a read may simply be sent again for: a timeout, no answer, or a 5xx. */
function transient(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  if (error.walk((e) => e instanceof TimeoutError)) return true;
  const http = error.walk((e) => e instanceof HttpRequestError);
  if (!(http instanceof HttpRequestError)) return false;
  return http.status === undefined || http.status >= 500 || http.status === 408;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * A short, single-line account of an RPC failure for a log, without the endpoint's URL (a provider's URL
 * holds its access token) or the request body.
 */
export function rpcErrorText(error: unknown): string {
  const limit = rateLimitOf(error);
  if (limit) {
    return limit.retryAfterMs === null
      ? "the RPC is rate-limiting us (HTTP 429)"
      : `the RPC is rate-limiting us (HTTP 429, retry after ${formatWait(limit.retryAfterMs)})`;
  }
  let text: string;
  if (error instanceof BaseError) text = error.shortMessage;
  else if (error instanceof Error) text = error.message.split("\n")[0] ?? error.name;
  else text = String(error);
  return redactUrls(text);
}

/** Replaces every http(s) URL in `text` with its origin's host only. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => {
    try {
      return `${new URL(url).host}/...`;
    } catch {
      return "[url]";
    }
  });
}
