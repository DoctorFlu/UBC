/**
 * A fake of Gemini's private Prediction Markets endpoints, for tests only (issue #93). It answers the
 * routes `@mandate/gemini/private` calls the way Gemini's documentation describes them, and checks every
 * request the way Gemini does: the API key, the HMAC-SHA384 signature of the payload, the payload's
 * `request` path and a strictly increasing nonce. Until the opt-in sandbox test has recorded real
 * answers, the shapes come from Gemini's OpenAPI spec (developer.gemini.com/specs/openapi/prediction-markets.yaml).
 *
 * One account, one key. Orders rest until a test fills or cancels them (`fill`, `cancelOpen`), and
 * `settle` resolves a contract and turns what the account holds on it into a settled position, as
 * Gemini's Get Settled Positions reports it: one entry per contract and outcome, all orders together.
 *
 * Use `handle` from an HTTP server (the end-to-end fake) or `fetch` in-process (unit tests).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { exactOrderIds } from "../src/private";
import { TokenBucket } from "../src/rate-limiter";

/** A limiter that never waits, for tests that send many signed requests at once. */
export function unpacedLimiter(): TokenBucket {
  return new TokenBucket({
    capacity: 1_000_000,
    refillPerMinute: 1_000_000,
    now: Date.now,
    sleep: () => Promise.resolve(),
  });
}

export interface FakeGeminiPrivateOptions {
  apiKey: string;
  apiSecret: string;
  /** Clock in milliseconds, for order times. */
  now?: () => number;
}

export interface FakeOrder {
  /** Decimal digits: real ids are 64-bit integers larger than a JavaScript number holds exactly. */
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  /** Hundredths of a contract. */
  quantity: number;
  filled: number;
  /** Cents per contract. */
  priceCents: number;
  /** Total cost of the fills in ten-thousandths of a dollar (hundredths times cents). */
  costUnits: number;
  status: "open" | "filled" | "cancelled";
  /** Placed with `makerOrCancel: true`. */
  makerOnly: boolean;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

/**
 * Someone else's buy order resting on the public book (another account's: the executor's NO bid that did
 * not fill at once, say). This account's buys meet it as Gemini's matching engine would.
 */
export interface FakeForeignOrder {
  symbol: string;
  outcome: "yes" | "no";
  priceCents: number;
  /** Hundredths of a contract still resting. */
  hundredths: number;
}

interface SettledEntry {
  symbol: string;
  outcome: "yes" | "no";
  quantity: number;
  resolutionSide: "yes" | "no";
  settledAt: string;
  eventTicker: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  /** The decoded payload, with `request` and `nonce` removed. */
  fields: Record<string, unknown>;
}

export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** What the next order placement does instead of answering normally. */
export type PlacementFault =
  /** Gemini refuses it with this answer; no order is made. */
  | { kind: "refuse"; status: number; body: unknown }
  /** No answer arrives, and no order is made. */
  | { kind: "drop-before" }
  /** The order is made, but no answer arrives (a timeout after Gemini acted). */
  | { kind: "drop-after" }
  /** The answer is a redirect to `location`; whether an order was made is unknown, so none is. */
  | { kind: "redirect"; status: 301 | 302 | 303 | 307 | 308; location: string };

const DROPPED = Symbol("dropped");

/** An answer's JSON as Gemini writes it: order ids as bare integers, digit for digit. */
export function answerText(body: unknown): string {
  return JSON.stringify(body).replace(/"orderId":"(\d+)"/g, '"orderId":$1');
}

function decimal(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  return rest === 0 ? String(whole) : `${String(whole)}.${String(rest).padStart(2, "0")}`;
}

function parseHundredths(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export class FakeGeminiPrivate {
  /** Every request that passed authentication, in order. */
  readonly requests: FakeRequest[] = [];
  readonly orders = new Map<string, FakeOrder>();
  termsAccepted = true;
  /** Whether answers carry the clientOrderId a placement sent (unverified on the real REST API). */
  echoClientOrderId = true;
  roles = { isTrader: true, isFundManager: false, isAuditor: false };
  balances = [{ type: "exchange", currency: "USD", amount: "100000.00", available: "100000.00" }];
  /** While true, every route answers 503. */
  failing = false;
  /**
   * Whether an order would take liquidity at once. A maker-only order that would is cancelled instead
   * (Gemini REST's `makerOrCancel`); other orders rest as usual, since this fake has no matching engine.
   */
  wouldTake: (order: {
    symbol: string;
    side: "buy" | "sell";
    outcome: "yes" | "no";
    priceCents: number;
  }) => boolean = () => false;
  /**
   * Other accounts' buy orders on the public book. A buy of this account's that meets one (a YES bid at y
   * and a NO bid at n on one contract meet when y + n >= 100) takes it at its price when placed as a plain
   * limit order, or is cancelled when placed maker only.
   */
  readonly foreign: FakeForeignOrder[] = [];
  /**
   * Placements that met an open order of this account's own on the other side of the same contract. A
   * maker-only one is cancelled, as Gemini cancels any order that would take liquidity; a plain one is kept
   * here too and rests, as a test then fails on this list being non-empty.
   */
  readonly selfCrosses: { placed: FakeOrder; met: FakeOrder }[] = [];
  /** Called after every request this fake answers, so a test can look at the book between requests. */
  afterRequest: (route: string) => void = () => {};
  private faults: PlacementFault[] = [];
  private settled: SettledEntry[] = [];
  /** Real-sized ids, above 2^53 like the sandbox's (145853902320696849), so rounding one shows up. */
  private nextOrderId = 145_853_902_320_696_849n;
  private lastNonce = 0;
  private readonly now: () => number;

  constructor(private readonly options: FakeGeminiPrivateOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The next placement fails this way (queued: one fault per placement). */
  failNextPlacement(fault: PlacementFault): void {
    this.faults.push(fault);
  }

  /** Requests to a path, for example "/v1/prediction-markets/order". */
  callsTo(path: string): FakeRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  /** Fills `hundredths` more of an open order (all that remains by default) at `priceCents` (its limit). */
  fill(orderId: string, hundredths?: number, priceCents?: number): FakeOrder {
    const order = this.order(orderId);
    if (order.status !== "open") throw new Error(`order ${orderId} is ${order.status}`);
    const amount = Math.min(hundredths ?? order.quantity - order.filled, order.quantity - order.filled);
    order.filled += amount;
    order.costUnits += amount * (priceCents ?? order.priceCents);
    order.updatedAt = this.iso();
    if (order.filled === order.quantity) order.status = "filled";
    return order;
  }

  /** Cancels every open order, as Gemini does when a contract stops trading. */
  cancelOpen(): void {
    for (const order of this.orders.values()) if (order.status === "open") this.cancel(order);
  }

  /**
   * Resolves `symbol` to `resolutionSide`: open orders on it are cancelled, and what the account holds on
   * it becomes a settled position per outcome. `eventTicker` is the contract's event.
   */
  settle(symbol: string, resolutionSide: "yes" | "no", eventTicker: string): void {
    const held = new Map<"yes" | "no", number>();
    for (const order of this.orders.values()) {
      if (order.symbol !== symbol) continue;
      if (order.status === "open") this.cancel(order);
      const signed = order.side === "buy" ? order.filled : -order.filled;
      held.set(order.outcome, (held.get(order.outcome) ?? 0) + signed);
    }
    for (const [outcome, quantity] of held) {
      if (quantity !== 0) {
        this.settled.unshift({
          symbol,
          outcome,
          quantity,
          resolutionSide,
          settledAt: this.iso(),
          eventTicker,
        });
      }
    }
  }

  /** Adds a settled position directly, for a disagreement with the public outcome. */
  addSettledPosition(entry: Omit<SettledEntry, "settledAt">): void {
    this.settled.unshift({ ...entry, settledAt: this.iso() });
  }

  /** The order by id. Throws when there is none. */
  order(orderId: string): FakeOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`no order ${orderId}`);
    return order;
  }

  /** In-process fetch for unit tests: base URL is ignored. A dropped answer rejects like a timeout. */
  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const answer = this.handle({
      method: init?.method ?? "GET",
      path: url.pathname,
      header: (name) => headers.get(name),
    });
    if (answer === DROPPED) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }
    return Promise.resolve(
      new Response(answerText(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json", ...answer.headers },
      }),
    );
  };

  /**
   * Answers one request, or returns `DROPPED` (see `isDropped`) when a fault says no answer arrives;
   * an HTTP server then leaves the request hanging until the client gives up.
   */
  handle(request: {
    method: string;
    path: string;
    header: (name: string) => string | null | undefined;
  }): FakeAnswer | typeof DROPPED {
    if (this.failing) return { status: 503, body: { error: "SERVICE_UNAVAILABLE", message: "Try later" } };
    const auth = this.authenticate(request);
    if ("status" in auth) return auth;
    const { fields } = auth;
    this.requests.push({ method: request.method, path: request.path, fields });
    const route = `${request.method} ${request.path}`;
    switch (route) {
      case "POST /v1/roles":
        return { status: 200, body: this.roles };
      case "POST /v1/balances":
        return { status: 200, body: this.balances };
      case "GET /v1/prediction-markets/terms/status":
        return {
          status: 200,
          body: {
            hasAcceptedLatest: this.termsAccepted,
            acceptedVersion: this.termsAccepted ? 2 : 1,
            latestVersion: 2,
          },
        };
      case "POST /v1/prediction-markets/order":
        return this.observed(route, this.place(fields));
      case "POST /v1/prediction-markets/order/cancel":
        return this.observed(route, this.cancelRoute(fields));
      case "POST /v1/prediction-markets/orders/active":
        return this.list(fields, (order) => order.status === "open");
      case "POST /v1/prediction-markets/orders/history":
        return this.list(fields, (order) => order.status !== "open");
      case "POST /v1/prediction-markets/positions":
        return { status: 200, body: this.openPositions() };
      case "POST /v1/prediction-markets/positions/settled":
        return {
          status: 200,
          body: {
            positions: this.settled.map((entry) => this.settledView(entry)),
            total: this.settled.length,
          },
        };
      default:
        return { status: 404, body: { error: "NotFound", message: `No route ${route}` } };
    }
  }

  private authenticate(request: {
    method: string;
    path: string;
    header: (name: string) => string | null | undefined;
  }): FakeAnswer | { fields: Record<string, unknown> } {
    const authError = (status: number, reason: string, message: string): FakeAnswer => ({
      status,
      body: { result: "error", reason, message },
    });
    const key = request.header("x-gemini-apikey");
    const payload = request.header("x-gemini-payload");
    const signature = request.header("x-gemini-signature");
    if (!key) return authError(400, "MissingApikeyHeader", "Missing X-GEMINI-APIKEY");
    if (!payload) return authError(400, "MissingPayloadHeader", "Missing X-GEMINI-PAYLOAD");
    if (!signature) return authError(400, "MissingSignatureHeader", "Missing X-GEMINI-SIGNATURE");
    if (key !== this.options.apiKey) return authError(403, "InvalidApiKey", "Invalid API key");
    const expected = createHmac("sha384", this.options.apiSecret).update(payload).digest();
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return authError(400, "InvalidSignature", "InvalidSignature");
    }
    let decoded: Record<string, unknown>;
    try {
      // As Gemini reads it: an order id keeps every digit (a string here), however large.
      decoded = JSON.parse(exactOrderIds(Buffer.from(payload, "base64").toString("utf8"))) as Record<
        string,
        unknown
      >;
    } catch {
      return authError(400, "InvalidJson", "Payload is not JSON");
    }
    const { request: path, nonce, ...fields } = decoded;
    if (path !== request.path)
      return authError(400, "InvalidRequest", "Payload request does not match the path");
    if (typeof nonce !== "number" || nonce <= this.lastNonce) {
      return authError(400, "InvalidNonce", "Nonce must be increasing");
    }
    this.lastNonce = nonce;
    return { fields };
  }

  private place(fields: Record<string, unknown>): FakeAnswer | typeof DROPPED {
    const fault = this.faults.shift();
    if (fault?.kind === "refuse") return { status: fault.status, body: fault.body };
    if (fault?.kind === "drop-before") return DROPPED;
    if (fault?.kind === "redirect") {
      return { status: fault.status, body: null, headers: { location: fault.location } };
    }
    if (!this.termsAccepted) {
      return {
        status: 403,
        body: {
          error: "TERMS_NOT_ACCEPTED",
          message: "Prediction markets terms must be accepted before placing orders",
        },
      };
    }
    // The sandbox's own answer to a longer id, measured on 2026-11-17; 36 characters are accepted.
    if (typeof fields.clientOrderId === "string" && fields.clientOrderId.length > 36) {
      return {
        status: 400,
        body: { error: "InvalidInput", message: "client_order_id must be at most 36 characters" },
      };
    }
    const quantity = parseHundredths(fields.quantity);
    const price = parseHundredths(fields.price);
    const side = fields.side;
    const outcome = fields.outcome;
    if (
      typeof fields.symbol !== "string" ||
      fields.orderType !== "limit" ||
      (side !== "buy" && side !== "sell") ||
      (outcome !== "yes" && outcome !== "no") ||
      quantity === null ||
      quantity <= 0 ||
      price === null ||
      price < 1 ||
      price > 99
    ) {
      return { status: 400, body: { error: "InvalidInput", message: "Invalid order" } };
    }
    // The sandbox's own answer to 0.01 contracts at 1 cent: an order must cost at least one cent.
    if (quantity * price < 100) {
      return {
        status: 400,
        body: {
          error: "InvalidInput",
          message: "Validation error for quantity: Order cost must be at least 0.01",
        },
      };
    }
    const makerOnly = fields.makerOrCancel === true;
    const order: FakeOrder = {
      orderId: String(this.nextOrderId++),
      clientOrderId: typeof fields.clientOrderId === "string" ? fields.clientOrderId : null,
      symbol: fields.symbol,
      side,
      outcome,
      quantity,
      filled: 0,
      priceCents: price,
      costUnits: 0,
      status: "open",
      makerOnly,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      cancelledAt: null,
    };
    this.orders.set(order.orderId, order);
    const meets = (yes: number, no: number) => yes + no >= 100;
    const crossing = (other: { symbol: string; outcome: "yes" | "no"; priceCents: number }) =>
      side === "buy" &&
      other.symbol === order.symbol &&
      other.outcome !== outcome &&
      (outcome === "yes" ? meets(price, other.priceCents) : meets(other.priceCents, price));
    const own = [...this.orders.values()].find(
      (other) => other !== order && other.status === "open" && other.side === "buy" && crossing(other),
    );
    if (own !== undefined) this.selfCrosses.push({ placed: order, met: own });
    const theirs = this.foreign.filter((other) => other.hundredths > 0 && crossing(other));
    if (
      makerOnly &&
      (own !== undefined ||
        theirs.length > 0 ||
        this.wouldTake({ symbol: order.symbol, side, outcome, priceCents: price }))
    ) {
      this.cancel(order);
    } else {
      // Best price first for the taker: the highest bid on the other side.
      for (const other of theirs.sort((a, b) => b.priceCents - a.priceCents)) {
        const amount = Math.min(other.hundredths, order.quantity - order.filled);
        if (amount <= 0) break;
        other.hundredths -= amount;
        this.fill(order.orderId, amount, 100 - other.priceCents);
      }
    }
    if (fault?.kind === "drop-after") return DROPPED;
    return { status: 201, body: this.orderView(order) };
  }

  private observed<T>(route: string, answer: T): T {
    this.afterRequest(route);
    return answer;
  }

  private cancelRoute(fields: Record<string, unknown>): FakeAnswer {
    const order = typeof fields.orderId === "string" ? this.orders.get(fields.orderId) : undefined;
    if (!order) return { status: 404, body: { error: "OrderNotFound", message: "Order not found" } };
    if (order.status !== "open") {
      return { status: 422, body: { error: "OrderNotCancellable", message: `Order is ${order.status}` } };
    }
    this.cancel(order);
    return {
      status: 200,
      body: { result: "ok", message: `Order ${order.orderId} cancelled successfully` },
    };
  }

  private list(fields: Record<string, unknown>, keep: (order: FakeOrder) => boolean): FakeAnswer {
    const orders = [...this.orders.values()]
      .filter((order) => keep(order) && (fields.symbol === undefined || order.symbol === fields.symbol))
      .reverse()
      .map((order) => this.orderView(order));
    return { status: 200, body: { orders, pagination: { limit: 100, offset: 0, count: orders.length } } };
  }

  /** What the account holds, per contract and outcome, from its filled orders (buys add, sells take away). */
  private openPositions(): Record<string, unknown> {
    const held = new Map<string, { symbol: string; outcome: string; quantity: number; costUnits: number }>();
    for (const order of this.orders.values()) {
      if (order.filled === 0) continue;
      const key = `${order.symbol}:${order.outcome}`;
      const entry = held.get(key) ?? {
        symbol: order.symbol,
        outcome: order.outcome,
        quantity: 0,
        costUnits: 0,
      };
      const sign = order.side === "buy" ? 1 : -1;
      entry.quantity += sign * order.filled;
      entry.costUnits += sign * order.costUnits;
      held.set(key, entry);
    }
    const positions = [...held.values()]
      .filter((entry) => entry.quantity > 0)
      .map((entry) => ({
        symbol: entry.symbol,
        instrumentId: 1,
        totalQuantity: decimal(entry.quantity),
        quantityOnHold: "0",
        avgPrice: (entry.costUnits / entry.quantity / 100).toFixed(4),
        outcome: entry.outcome,
        isLive: true,
        realizedPl: "0",
      }));
    return { positions, total: positions.length };
  }

  private cancel(order: FakeOrder): void {
    order.status = "cancelled";
    order.cancelledAt = this.iso();
    order.updatedAt = order.cancelledAt;
  }

  private orderView(order: FakeOrder): Record<string, unknown> {
    const average = order.filled === 0 ? null : (order.costUnits / order.filled / 100).toFixed(4);
    return {
      orderId: order.orderId,
      hashOrderId: null,
      clientOrderId: this.echoClientOrderId ? order.clientOrderId : null,
      globalOrderId: null,
      status: order.status,
      symbol: order.symbol,
      side: order.side,
      outcome: order.outcome,
      orderType: "limit",
      quantity: decimal(order.quantity),
      filledQuantity: decimal(order.filled),
      remainingQuantity: decimal(order.status === "open" ? order.quantity - order.filled : 0),
      price: `0.${String(order.priceCents).padStart(2, "0")}`,
      avgExecutionPrice: average,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      cancelledAt: order.cancelledAt,
    };
  }

  private settledView(entry: SettledEntry): Record<string, unknown> {
    const quantity = Math.abs(entry.quantity);
    const won = entry.outcome === entry.resolutionSide && entry.quantity > 0;
    return {
      accountId: 1,
      instrumentId: 1,
      instrumentSymbol: entry.symbol,
      position: decimal(quantity).replace(/^/, entry.quantity < 0 ? "-" : ""),
      positionQuantity: decimal(quantity),
      outcome: entry.outcome,
      payout: won ? (quantity / 100).toFixed(2) : "0",
      resolutionSide: entry.resolutionSide,
      settledAt: entry.settledAt,
      contractMetadata: {
        eventTicker: entry.eventTicker,
        contractStatus: "resolved",
        resolutionSide: entry.resolutionSide,
      },
      realizedPnl: "0",
    };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** True for the value `handle` returns when no answer should arrive. */
export function isDropped(answer: FakeAnswer | typeof DROPPED): answer is typeof DROPPED {
  return answer === DROPPED;
}
