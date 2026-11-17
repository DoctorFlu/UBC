/**
 * Signed client for Gemini's private Prediction Markets endpoints (issue #93): the only code in the
 * repository that holds an API secret or can place an order.
 *
 * Authentication, from Gemini's "API key authentication" page: the request's JSON fields, plus `request`
 * (the path) and `nonce`, are base64-encoded into the `X-GEMINI-PAYLOAD` header; `X-GEMINI-SIGNATURE` is the
 * hex HMAC-SHA384 of that base64 text keyed with the API secret; `X-GEMINI-APIKEY` names the key; the body
 * is empty. The nonce is the time in whole seconds, one higher than the last when two requests share a
 * second, so it suits a key made with either of Gemini's nonce modes (time-based within 30 seconds, or
 * strictly increasing). Requests go out one at a time, in nonce order.
 *
 * Safety rules this client keeps whatever its caller does:
 * - A signed request goes only to Gemini's own host for the chosen environment, or to a loopback test
 *   server. A configurable URL is never trusted with a key, and a redirect is never followed: fetch keeps
 *   custom headers across origins, so following one would hand the key, payload and signature to whatever
 *   host the answer names. A redirect is reported as `redirected`, an unknown outcome.
 * - Production needs `allowProduction: true` on top of `environment: "production"`.
 * - Nothing is retried. A failed order may or may not exist (see `GeminiPrivateError.outcomeUnknown`); the
 *   caller looks it up instead of sending it again.
 * - Neither the secret nor the signed headers ever appear in an error, a log line or a return value.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { FetchLike } from "./http";
import { classifyAnswer, GeminiPrivateError } from "./private-errors";
import { TokenBucket } from "./rate-limiter";

/** Gemini's REST hosts. The sandbox (exchange.sandbox.gemini.com accounts) trades test funds only. */
export const GEMINI_HOSTS = {
  sandbox: "https://api.sandbox.gemini.com",
  production: "https://api.gemini.com",
} as const;

export type GeminiEnvironment = keyof typeof GEMINI_HOSTS;

export const GEMINI_ENVIRONMENTS = Object.keys(GEMINI_HOSTS) as GeminiEnvironment[];

export interface GeminiCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface GeminiPrivateClientOptions {
  environment: GeminiEnvironment;
  credentials: GeminiCredentials;
  /** Must be true for `environment: "production"`, where orders spend real money. */
  allowProduction?: boolean;
  /**
   * Tests only: a loopback `http://127.0.0.1:<port>` or `http://localhost:<port>` server (the fake Gemini)
   * that stands in for the environment's host. Anything else is refused.
   */
  testBaseUrl?: string;
  fetch?: FetchLike;
  /** Clock in milliseconds, for the nonce. */
  now?: () => number;
  timeoutMs?: number;
  /**
   * Paces signed requests. Default: one a second on average, bursts of two; Gemini allows 600 private
   * requests a minute, and the nonce stays within a second or two of the clock.
   */
  limiter?: TokenBucket;
}

// ------------------------------------------------------------------------------------------- answers

/**
 * Gemini's order ids are 64-bit integers, and real ones are larger than a JavaScript number holds exactly
 * (the sandbox answered 145853902320696849, above 2^53). `exactOrderIds` turns them into strings before
 * `JSON.parse` can round them; this client keeps them as decimal strings throughout and sends them back
 * as the same digits. A number that still reaches the schema was small enough to be exact.
 */
const orderIdSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)])
  .refine((value) => typeof value === "string" || Number.isSafeInteger(value), "order id too large")
  .transform(String);

/** Quotes every integer `orderId` in a JSON text, so that parsing it loses no digit. */
export function exactOrderIds(text: string): string {
  return text.replace(/("orderId"\s*:\s*)(\d+)(?=\s*[,}\]])/g, '$1"$2"');
}

/** A whole number written into a signed payload digit for digit, however large. */
class RawInteger {
  constructor(readonly digits: string) {}
}

/** `JSON.stringify`, but a `RawInteger` is written as its digits, unquoted and unrounded. */
function stringifyPayload(value: Record<string, unknown>): string {
  const raws: string[] = [];
  const text = JSON.stringify(value, (_key, field: unknown) => {
    if (!(field instanceof RawInteger)) return field;
    raws.push(field.digits);
    return `\u0000raw${String(raws.length - 1)}`;
  });
  return text.replace(/"\\u0000raw(\d+)"/g, (_match, index: string) => raws[Number(index)] ?? "");
}

const decimal = z.union([z.string(), z.number()]).transform(String);

/** One order, as Place Order, Get Active Orders and Get Order History return it. */
export const privateOrderSchema = z.object({
  orderId: orderIdSchema,
  clientOrderId: z.string().nullish(),
  status: z.string(),
  symbol: z.string(),
  side: z.string(),
  outcome: z.string(),
  orderType: z.string().nullish(),
  quantity: decimal,
  filledQuantity: decimal.nullish(),
  remainingQuantity: decimal.nullish(),
  price: decimal,
  avgExecutionPrice: decimal.nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  cancelledAt: z.string().nullish(),
});
export type PrivateOrder = z.infer<typeof privateOrderSchema>;

const ordersSchema = z.object({ orders: z.array(privateOrderSchema) });

/** One resolved position, as Get Settled Positions returns it. */
export const settledPositionSchema = z.object({
  instrumentSymbol: z.string(),
  outcome: z.string(),
  /** Contracts held at settlement (unsigned). */
  positionQuantity: decimal.nullish(),
  /** Signed quantity: negative for a short. */
  position: decimal.nullish(),
  /** Dollars paid at settlement. */
  payout: decimal.nullish(),
  resolutionSide: z.string().nullish(),
  settledAt: z.string().nullish(),
  costBasis: decimal.nullish(),
  contractMetadata: z
    .object({ eventTicker: z.string().nullish(), resolutionSide: z.string().nullish() })
    .nullish(),
});
export type SettledPosition = z.infer<typeof settledPositionSchema>;

const settledPositionsSchema = z.object({ positions: z.array(settledPositionSchema) });

export const termsStatusSchema = z.object({
  hasAcceptedLatest: z.boolean(),
  acceptedVersion: z.number().int().nullish(),
  latestVersion: z.number().int().nullish(),
});
export type TermsStatus = z.infer<typeof termsStatusSchema>;

export const rolesSchema = z.object({
  isTrader: z.boolean().nullish(),
  isFundManager: z.boolean().nullish(),
  isAuditor: z.boolean().nullish(),
  isAccountAdmin: z.boolean().nullish(),
});
export type KeyRoles = z.infer<typeof rolesSchema>;

export const balanceSchema = z.object({
  currency: z.string(),
  amount: decimal.nullish(),
  available: decimal.nullish(),
});
export type Balance = z.infer<typeof balanceSchema>;

const balancesSchema = z.array(balanceSchema);

const cancelSchema = z.object({ result: z.string().nullish(), message: z.string().nullish() });

// ------------------------------------------------------------------------------------------- requests

/** A limit order, exactly as it is sent. Prices and quantities are decimal strings. */
export interface LimitOrderRequest {
  /** The contract's `instrumentSymbol`, as Gemini's event data returns it. */
  symbol: string;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  /** Contracts, for example "12.34". */
  quantity: string;
  /** Dollars per contract, 0 to 1, for example "0.42". */
  price: string;
  /**
   * Our own id for the order. Gemini's REST reference does not list it as a request field, but the sandbox
   * takes it and returns it in the place answer, the active list and the history (checked with a key on
   * 17 November 2026). Nothing in this client depends on Gemini keeping it.
   */
  clientOrderId?: string;
}

export interface GeminiPrivateClient {
  readonly environment: GeminiEnvironment;
  /** The roles of the key. Any role may call it, and it changes nothing. */
  roles(): Promise<KeyRoles>;
  /** The account's balances. Trader, Fund Manager or Auditor role. */
  balances(): Promise<Balance[]>;
  /** Whether the account accepted the latest Prediction Markets terms. Never accepts them. */
  termsStatus(): Promise<TermsStatus>;
  /** Places a good-til-cancel limit order. Never retried; see `GeminiPrivateError.outcomeUnknown`. */
  placeOrder(order: LimitOrderRequest): Promise<PrivateOrder>;
  /** Asks Gemini to cancel an order. Cancelling twice is harmless. */
  cancelOrder(orderId: string): Promise<void>;
  /** Open orders on one contract, or on every contract when no symbol is given, newest first (at most 100). */
  activeOrders(symbol?: string): Promise<PrivateOrder[]>;
  /** Filled and cancelled orders on one contract, or on every contract (at most 100). */
  orderHistory(symbol?: string): Promise<PrivateOrder[]>;
  /** The account's settled positions, most recent first (at most 1000). */
  settledPositions(): Promise<SettledPosition[]>;
}

/** True for `http://127.0.0.1:<port>` and `http://localhost:<port>`, with nothing after the port. */
export function isLoopbackTestUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.pathname.replace(/\/+$/, "") === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** The host a redirect names, for the error message only; never requested. */
function redirectHost(location: string | null, base: string): string | undefined {
  if (location === null || !URL.canParse(location, base)) return undefined;
  return new URL(location, base).host.slice(0, 100);
}

function invalid(message: string): GeminiPrivateError {
  return new GeminiPrivateError("invalid_argument", message);
}

/**
 * The private client for one environment. Throws `invalid_argument` at once (nothing sent) for a missing
 * key, production without `allowProduction`, or a test URL that is not loopback.
 */
export function createGeminiPrivateClient(options: GeminiPrivateClientOptions): GeminiPrivateClient {
  const { environment, credentials } = options;
  if (!(environment in GEMINI_HOSTS)) throw invalid(`unknown Gemini environment "${environment}"`);
  if (environment === "production" && options.allowProduction !== true) {
    throw invalid("production trades real money and needs allowProduction");
  }
  const apiKey = credentials.apiKey.trim();
  const apiSecret = credentials.apiSecret.trim();
  if (apiKey === "" || apiSecret === "") throw invalid("the API key and secret must both be set");
  let baseUrl: string = GEMINI_HOSTS[environment];
  if (options.testBaseUrl !== undefined) {
    if (!isLoopbackTestUrl(options.testBaseUrl)) {
      throw invalid("a signed request goes only to Gemini or to a loopback test server");
    }
    baseUrl = options.testBaseUrl.replace(/\/+$/, "");
  }

  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Paced in wall time, whatever clock the nonce reads.
  const limiter =
    options.limiter ??
    new TokenBucket({
      capacity: 2,
      refillPerMinute: 60,
      now: Date.now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });
  let lastNonce = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function call<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    fields: Record<string, unknown>,
    schema: S,
  ): Promise<z.output<S>> {
    await limiter.acquire();
    lastNonce = Math.max(Math.floor(now() / 1000), lastNonce + 1);
    const payload = Buffer.from(stringifyPayload({ request: path, nonce: lastNonce, ...fields })).toString(
      "base64",
    );
    const signature = createHmac("sha384", apiSecret).update(payload).digest("hex");
    let response: Response;
    try {
      response = await send(baseUrl + path, {
        method,
        headers: {
          // No body: fetch sends Content-Length 0 on a POST by itself.
          "Content-Type": "text/plain",
          "Cache-Control": "no-cache",
          "X-GEMINI-APIKEY": apiKey,
          "X-GEMINI-PAYLOAD": payload,
          "X-GEMINI-SIGNATURE": signature,
        },
        // Never "follow": the signed headers would go to the redirect's host. See `redirected` below.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new GeminiPrivateError(
        timedOut ? "timeout" : "network",
        timedOut
          ? `${method} ${path} got no answer within ${String(timeoutMs)} ms`
          : `${method} ${path} failed before an answer arrived (${cause instanceof Error ? cause.message : String(cause)})`,
        { path, cause },
      );
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      // Not followed. Gemini's API never redirects, so whatever answered may or may not have acted.
      await response.body?.cancel().catch(() => undefined);
      const target = redirectHost(response.headers.get("location"), baseUrl);
      throw new GeminiPrivateError(
        "redirected",
        `${method} ${path} answered with a redirect (HTTP ${String(response.status)}${target ? ` to ${target}` : ""}); it was not followed, so nothing signed went there`,
        { status: response.status, path },
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new GeminiPrivateError("network", `${method} ${path}: the answer was cut off`, { path, cause });
    }
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(exactOrderIds(text));
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const { kind, reason, message } = classifyAnswer(response.status, body);
      const said = [reason, message].filter(Boolean).join(": ");
      throw new GeminiPrivateError(
        kind,
        `${method} ${path} returned HTTP ${String(response.status)}${said ? ` (${said.slice(0, 300)})` : ""}`,
        { status: response.status, ...(reason === undefined ? {} : { reason }), path },
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
      throw new GeminiPrivateError(
        "invalid_response",
        `${method} ${path} answered an unexpected shape${where}`,
        {
          status: response.status,
          path,
        },
      );
    }
    return parsed.data;
  }

  /** One request at a time, so nonces reach Gemini in the order they were made. */
  function serial<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    fields: Record<string, unknown>,
    schema: S,
  ): Promise<z.output<S>> {
    const turn = queue.then(() => call(method, path, fields, schema));
    queue = turn.catch(() => undefined);
    return turn;
  }

  return {
    environment,
    roles: () => serial("POST", "/v1/roles", {}, rolesSchema),
    balances: () => serial("POST", "/v1/balances", {}, balancesSchema),
    termsStatus: () => serial("GET", "/v1/prediction-markets/terms/status", {}, termsStatusSchema),
    placeOrder(order) {
      if (!/^\d+(\.\d+)?$/.test(order.quantity) || !/^0\.\d+$/.test(order.price)) {
        return Promise.reject(invalid("quantity and price must be plain decimals, price below 1"));
      }
      return serial(
        "POST",
        "/v1/prediction-markets/order",
        {
          symbol: order.symbol,
          orderType: "limit",
          side: order.side,
          quantity: order.quantity,
          price: order.price,
          outcome: order.outcome,
          timeInForce: "good-til-cancel",
          ...(order.clientOrderId === undefined ? {} : { clientOrderId: order.clientOrderId }),
        },
        privateOrderSchema,
      );
    },
    async cancelOrder(orderId) {
      if (!/^\d{1,20}$/.test(orderId) || BigInt(orderId) > 2n ** 64n - 1n) {
        throw invalid("an order id is a whole number of at most 64 bits");
      }
      // Sent as the same digits Gemini gave, never through a JavaScript number that would round it.
      await serial(
        "POST",
        "/v1/prediction-markets/order/cancel",
        { orderId: new RawInteger(orderId) },
        cancelSchema,
      );
    },
    async activeOrders(symbol) {
      const answer = await serial(
        "POST",
        "/v1/prediction-markets/orders/active",
        { ...(symbol === undefined ? {} : { symbol }), limit: 100 },
        ordersSchema,
      );
      return answer.orders;
    },
    async orderHistory(symbol) {
      const answer = await serial(
        "POST",
        "/v1/prediction-markets/orders/history",
        { ...(symbol === undefined ? {} : { symbol }), limit: 100 },
        ordersSchema,
      );
      return answer.orders;
    },
    async settledPositions() {
      const answer = await serial(
        "POST",
        "/v1/prediction-markets/positions/settled",
        {},
        settledPositionsSchema,
      );
      return answer.positions;
    },
  };
}
