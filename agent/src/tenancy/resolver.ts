/**
 * Which agent a bearer token belongs to (docs/accounts.md). The console is the system of record for agent
 * tokens: the MCP server sends it the token's SHA-256, never the token, and acts for the agent it names.
 *
 * Nothing is cached, so a token revoked in the console stops working on its next call. When the console
 * cannot answer, the MCP server refuses the call (503) rather than guess, and it keeps no local copy of
 * `MCP_AUTH_TOKEN` to fall back on: a revoked env-file token must stay revoked.
 *
 * The lookup runs before a tool call's deadline (`MCP_TOOL_DEADLINE_MS`) starts, so it has its own bound,
 * `RESOLVE_TIMEOUT_MS`, covering the answer's headers and its body: a slow console makes a request wait
 * at most that long, then answer 503. The most a call can take is this bound, the tool deadline and the
 * unwind grace, 5 + 40 + 3 seconds at the largest deadline, under the 60 seconds MCP clients wait.
 */
import {
  CONSOLE_AGENT_ROUTES,
  hashAgentToken,
  resolveTokenRequestSchema,
  resolveTokenResponseSchema,
  type ResolveTokenResponse,
} from "@mandate/shared";
import type { Config } from "../config";
import { constantTimeEqual } from "../http/auth";
import type { Secret } from "../secret";

/** The agent a token acts for, as the console resolved it. */
export type ResolvedAgent = ResolveTokenResponse;

export type Resolution =
  /** A live token: act for this agent. */
  | { kind: "agent"; agent: ResolvedAgent }
  /** No live token has this hash: unknown, revoked, or the env-file token after its revocation. */
  | { kind: "unknown" }
  /** The console limits failed lookups and asks to wait this many seconds. */
  | { kind: "limited"; retryAfter: number }
  /**
   * The console did not answer usefully (down, timed out, misconfigured): refuse the call. `timedOut`
   * when it did not answer within the lookup's bound.
   */
  | { kind: "unavailable"; reason: string; timedOut?: true };

export interface TokenResolver {
  resolve(token: string, signal?: AbortSignal): Promise<Resolution>;
}

/** How long one token lookup may take, headers and body, before the request is refused with 503. */
export const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Settles with `work`, or rejects as soon as `signal` aborts, even when `work` ignores the signal (a
 * fetch that does not honour it, or a body that stops arriving).
 */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Asks the console's `auth/resolve` route over the private network, with the service token. */
export class ConsoleTokenResolver implements TokenResolver {
  readonly #baseUrl: string;
  readonly #serviceToken: Secret;
  readonly #legacyToken: Secret;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    serviceToken: Secret;
    /** `MCP_AUTH_TOKEN`: presented, it is sent with `legacy: true` so the console can register it once. */
    legacyToken: Secret;
    fetch?: FetchLike;
    timeoutMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#serviceToken = options.serviceToken;
    this.#legacyToken = options.legacyToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  }

  async resolve(token: string, signal?: AbortSignal): Promise<Resolution> {
    const body = resolveTokenRequestSchema.parse({
      tokenHash: hashAgentToken(token),
      legacy: constantTimeEqual(token, this.#legacyToken.reveal()),
    });
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    // Why the lookup stopped, when it did: the bound, or the client going away first.
    const stopped = (): Resolution | undefined => {
      if (timeout.aborted) {
        return {
          kind: "unavailable",
          reason: `the console did not answer within ${String(this.#timeoutMs)} ms`,
          timedOut: true,
        };
      }
      if (signal?.aborted) return { kind: "unavailable", reason: "the client went away" };
      return undefined;
    };
    let response: Response;
    try {
      response = await bounded(
        this.#fetch(`${this.#baseUrl}${CONSOLE_AGENT_ROUTES.resolveToken}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${this.#serviceToken.reveal()}`,
          },
          body: JSON.stringify(body),
          signal: bound,
        }),
        bound,
      );
    } catch {
      return stopped() ?? { kind: "unavailable", reason: "the console could not be reached" };
    }
    if (response.status === 404) return { kind: "unknown" };
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return { kind: "limited", retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1 };
    }
    if (response.status !== 200) {
      return {
        kind: "unavailable",
        reason:
          response.status === 401 || response.status === 503
            ? "the console refused the service token"
            : `the console answered HTTP ${String(response.status)}`,
      };
    }
    let payload: unknown;
    try {
      payload = await bounded(response.json(), bound);
    } catch {
      const why = stopped();
      if (why !== undefined) return why;
      payload = undefined;
    }
    const parsed = resolveTokenResponseSchema.safeParse(payload);
    if (!parsed.success)
      return { kind: "unavailable", reason: "the console's answer does not match the wire contract" };
    return { kind: "agent", agent: parsed.data };
  }
}

/** Refuses every token: the server has no console to ask (`CONSOLE_SERVICE_TOKEN` is not set). */
export const noConsoleResolver: TokenResolver = {
  resolve: () =>
    Promise.resolve({
      kind: "unavailable",
      reason: "the MCP server is not linked to a console (CONSOLE_SERVICE_TOKEN)",
    }),
};

/** The resolver for this configuration. */
export function createTokenResolver(
  config: Config,
  fetchImpl?: FetchLike,
  options: { timeoutMs?: number } = {},
): TokenResolver {
  if (config.consoleServiceToken === undefined) return noConsoleResolver;
  return new ConsoleTokenResolver({
    baseUrl: config.consoleUrl,
    serviceToken: config.consoleServiceToken,
    legacyToken: config.authToken,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/**
 * A resolver that knows tokens up front, for tests that run the MCP server without a console: each token
 * maps to the agent it acts for.
 */
export function staticResolver(tokens: ReadonlyMap<string, ResolvedAgent>): TokenResolver {
  return {
    resolve: (token) => {
      for (const [known, agent] of tokens) {
        if (constantTimeEqual(token, known)) return Promise.resolve({ kind: "agent", agent });
      }
      return Promise.resolve({ kind: "unknown" });
    },
  };
}

/** The first mandate's agent, the one the server's own key signs for, as the console names it. */
export function envAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    workspaceId: "wsp_first",
    mandateId: "mnd_first",
    agentId: "env",
    tokenId: "tok_env",
    agent: { address: null, signer: "env" },
    mandate: { deployment: "env" },
    ...overrides,
  };
}
