/**
 * Client for the console's agent API (`@mandate/shared` `console-api.ts`). Every request body is
 * validated before it leaves and every response is validated when it arrives, with the same
 * schemas the console uses, so drift between the two sides fails loudly instead of silently.
 */
import type * as z from "zod";
import {
  CONSOLE_AGENT_ROUTES,
  consoleErrorSchema,
  contextResponseSchema,
  holdingsResponseSchema,
  intentContextResponseSchema,
  pairingResponseSchema,
  planResponseSchema,
  policyChangeRequestSchema,
  postPlanRequestSchema,
  postPolicyChangeRequestSchema,
  putContextRequestSchema,
  putIntentContextRequestSchema,
  putPairingRequestSchema,
  putSignalBudgetRequestSchema,
  putSignalPaymentRequestSchema,
  settlementsResponseSchema,
  signalBudgetResponseSchema,
  signalPaymentResponseSchema,
  type ContextResponse,
  type DecisionContext,
  type HoldingsResponse,
  type IntentContextResponse,
  type PairingResponse,
  type PlanResponse,
  type PolicyChangeRequest,
  type PostPlanRequest,
  type PostPolicyChangeRequest,
  type PutIntentContextRequest,
  type PutPairingRequest,
  type PutSignalBudgetRequest,
  type PutSignalPaymentRequest,
  type SettlementsResponse,
  type SignalBudgetResponse,
  type SignalPaymentResponse,
} from "@mandate/shared";
import type { Config } from "../config";
import type { Secret } from "../secret";
import type { ConsoleClient } from "../services";

/**
 * Why a console call failed:
 * - `unreachable`: no answer (console down, wrong URL, timeout).
 * - `unauthorized`: 401, the service tokens on the two sides differ.
 * - `rejected`: 422, the console refused the body; `code` and `message` come from the console.
 * - `conflict`: 409, the console already holds a different record under this key; `code` and
 *   `message` come from the console. Repeating the call cannot succeed.
 * - `bad_response`: an answer that does not match the wire contract, or an unexpected status.
 */
export type ConsoleFailure = "unreachable" | "unauthorized" | "rejected" | "conflict" | "bad_response";

export class ConsoleClientError extends Error {
  override readonly name = "ConsoleClientError";
  readonly kind: ConsoleFailure;
  readonly status: number | undefined;
  /** The console's own error code, for `rejected` and `conflict`. */
  readonly code: string | undefined;

  constructor(
    kind: ConsoleFailure,
    message: string,
    details: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
  }
}

export const CONSOLE_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpConsoleClient implements ConsoleClient {
  readonly baseUrl: string;
  readonly #token: Secret;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: { baseUrl: string; token: Secret; fetch?: FetchLike; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? CONSOLE_TIMEOUT_MS;
  }

  async getHoldings(signal?: AbortSignal): Promise<HoldingsResponse> {
    return this.#call("GET", CONSOLE_AGENT_ROUTES.holdings, holdingsResponseSchema, { signal });
  }

  async putContext(
    hash: `0x${string}`,
    document: DecisionContext,
    signal?: AbortSignal,
  ): Promise<ContextResponse> {
    const body = putContextRequestSchema.parse({ document });
    return this.#call("PUT", CONSOLE_AGENT_ROUTES.context(hash), contextResponseSchema, { body, signal });
  }

  async getContext(hash: `0x${string}`, signal?: AbortSignal): Promise<ContextResponse | null> {
    return this.#call("GET", CONSOLE_AGENT_ROUTES.context(hash), contextResponseSchema, {
      signal,
      notFoundAsNull: true,
    });
  }

  async putIntentContext(
    intentId: number,
    request: PutIntentContextRequest,
    signal?: AbortSignal,
  ): Promise<IntentContextResponse> {
    const body = putIntentContextRequestSchema.parse(request);
    return this.#call("PUT", CONSOLE_AGENT_ROUTES.intentContext(intentId), intentContextResponseSchema, {
      body,
      signal,
    });
  }

  async postPlan(request: PostPlanRequest, signal?: AbortSignal): Promise<PlanResponse> {
    const body = postPlanRequestSchema.parse(request);
    return this.#call("POST", CONSOLE_AGENT_ROUTES.plans, planResponseSchema, { body, signal });
  }

  async postPolicyChangeRequest(
    request: PostPolicyChangeRequest,
    signal?: AbortSignal,
  ): Promise<PolicyChangeRequest> {
    const body = postPolicyChangeRequestSchema.parse(request);
    return this.#call("POST", CONSOLE_AGENT_ROUTES.policyChangeRequests, policyChangeRequestSchema, {
      body,
      signal,
    });
  }

  async putPairing(request: PutPairingRequest, signal?: AbortSignal): Promise<PairingResponse> {
    const body = putPairingRequestSchema.parse(request);
    return this.#call("PUT", CONSOLE_AGENT_ROUTES.pairing, pairingResponseSchema, { body, signal });
  }

  async getPairing(signal?: AbortSignal): Promise<PairingResponse | null> {
    return this.#call("GET", CONSOLE_AGENT_ROUTES.pairing, pairingResponseSchema, {
      signal,
      notFoundAsNull: true,
    });
  }

  async putSignalPayment(
    receiptId: string,
    request: PutSignalPaymentRequest,
    signal?: AbortSignal,
  ): Promise<SignalPaymentResponse | null> {
    const body = putSignalPaymentRequestSchema.parse(request);
    return this.#call("PUT", CONSOLE_AGENT_ROUTES.signalPayment(receiptId), signalPaymentResponseSchema, {
      body,
      signal,
      notFoundAsNull: true,
    });
  }

  async putSignalBudget(
    request: PutSignalBudgetRequest,
    signal?: AbortSignal,
  ): Promise<SignalBudgetResponse | null> {
    const body = putSignalBudgetRequestSchema.parse(request);
    return this.#call("PUT", CONSOLE_AGENT_ROUTES.signalBudget, signalBudgetResponseSchema, {
      body,
      signal,
      notFoundAsNull: true,
    });
  }

  async getSettlements(signal?: AbortSignal): Promise<SettlementsResponse | null> {
    return this.#call("GET", CONSOLE_AGENT_ROUTES.settlements, settlementsResponseSchema, {
      signal,
      notFoundAsNull: true,
    });
  }

  async #call<S extends z.ZodType>(
    method: "GET" | "PUT" | "POST",
    path: string,
    schema: S,
    options: { body?: unknown; signal?: AbortSignal | undefined; notFoundAsNull: true },
  ): Promise<z.output<S> | null>;
  async #call<S extends z.ZodType>(
    method: "GET" | "PUT" | "POST",
    path: string,
    schema: S,
    options: { body?: unknown; signal?: AbortSignal | undefined; notFoundAsNull?: false },
  ): Promise<z.output<S>>;
  async #call<S extends z.ZodType>(
    method: "GET" | "PUT" | "POST",
    path: string,
    schema: S,
    options: { body?: unknown; signal?: AbortSignal | undefined; notFoundAsNull?: boolean },
  ): Promise<z.output<S> | null> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.#token.reveal()}`,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new ConsoleClientError("unreachable", `${method} ${path}: the console did not answer`, {
        cause: error,
      });
    }

    const payload = await readJson(response);
    if (response.status === 404 && options.notFoundAsNull === true) return null;
    if (response.status === 401) {
      throw new ConsoleClientError(
        "unauthorized",
        `${method} ${path}: the console refused the service token`,
        {
          status: 401,
        },
      );
    }
    if (response.status === 422 || response.status === 409) {
      const parsed = consoleErrorSchema.safeParse(payload);
      const kind = response.status === 422 ? "rejected" : "conflict";
      throw new ConsoleClientError(
        kind,
        parsed.success
          ? parsed.data.error.message
          : `${method} ${path}: the console ${kind === "rejected" ? "refused" : "has a conflicting record for"} the request`,
        { status: response.status, ...(parsed.success ? { code: parsed.data.error.code } : {}) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ConsoleClientError(
        response.status >= 500 ? "unreachable" : "bad_response",
        `${method} ${path}: the console answered HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ConsoleClientError(
        "bad_response",
        `${method} ${path}: the console's answer does not match the wire contract`,
        { status: response.status, cause: parsed.error },
      );
    }
    return parsed.data;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The console client for this configuration, or undefined when no service token is set. */
export function createConsoleClient(config: Config, fetchImpl?: FetchLike): ConsoleClient | undefined {
  if (config.consoleServiceToken === undefined) return undefined;
  return new HttpConsoleClient({
    baseUrl: config.consoleUrl,
    token: config.consoleServiceToken,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
