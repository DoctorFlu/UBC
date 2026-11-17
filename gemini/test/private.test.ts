import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGeminiPrivateClient,
  GEMINI_HOSTS,
  geminiTradingSettings,
  isGeminiPrivateError,
  isLoopbackTestUrl,
  keyScope,
  type GeminiPrivateClient,
} from "../src/private-index";
import { FakeGeminiPrivate, unpacedLimiter } from "../testing/fake-private";
import { json } from "./helpers";

const KEY = "account-TESTKEYTESTKEY0001";
const SECRET = "TestSecretThatMustNeverAppearAnywhere";
const NOW = Date.parse("2026-11-17T08:00:00Z");

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recording(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = { url: input, method: init?.method ?? "GET", headers, body: init?.body };
    sent.push(request);
    return answer(request);
  };
  return { sent, fetch: fetchImpl };
}

function client(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, now = () => NOW) {
  return createGeminiPrivateClient({
    environment: "sandbox",
    credentials: { apiKey: KEY, apiSecret: SECRET },
    fetch: fetchImpl,
    now,
    limiter: unpacedLimiter(),
  });
}

function decodePayload(header: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")) as Record<string, unknown>;
}

describe("the signed request", () => {
  it("follows Gemini's API key scheme: base64 payload, hex HMAC-SHA384, empty body", async () => {
    const { sent, fetch } = recording(() => json({ isTrader: true, isAuditor: false }));
    await expect(client(fetch).roles()).resolves.toMatchObject({ isTrader: true });

    const [request] = sent;
    expect(request?.url).toBe(`${GEMINI_HOSTS.sandbox}/v1/roles`);
    expect(request?.method).toBe("POST");
    expect(request?.body).toBeUndefined();
    const payload = request?.headers["x-gemini-payload"] ?? "";
    expect(decodePayload(payload)).toEqual({ request: "/v1/roles", nonce: NOW / 1000 });
    // Gemini's own example: hex(HMAC_SHA384(base64(payload), key=api_secret)).
    expect(request?.headers["x-gemini-signature"]).toBe(
      createHmac("sha384", SECRET).update(payload).digest("hex"),
    );
    expect(request?.headers["x-gemini-apikey"]).toBe(KEY);
    expect(request?.headers["content-type"]).toBe("text/plain");
  });

  it("never puts the secret in a URL or a header", async () => {
    const { sent, fetch } = recording(() => json({ hasAcceptedLatest: true }));
    const gemini = client(fetch);
    await gemini.termsStatus();
    await gemini.balances().catch(() => undefined);
    for (const request of sent) {
      expect(request.url).not.toContain(SECRET);
      for (const value of Object.values(request.headers)) {
        expect(value).not.toContain(SECRET);
        expect(Buffer.from(value, "base64").toString("utf8")).not.toContain(SECRET);
      }
    }
  });

  it("puts the fields in the payload and sends the order as a good-til-cancel limit order", async () => {
    const { sent, fetch } = recording(() =>
      json(
        {
          orderId: 12345678901,
          status: "open",
          symbol: "GEMI-BTC2611202200-HI67000",
          side: "buy",
          outcome: "no",
          quantity: "125",
          filledQuantity: "0",
          remainingQuantity: "125",
          price: "0.4",
          avgExecutionPrice: null,
        },
        201,
      ),
    );
    const order = await client(fetch).placeOrder({
      symbol: "GEMI-BTC2611202200-HI67000",
      side: "buy",
      outcome: "no",
      quantity: "125",
      price: "0.40",
      clientOrderId: "mandate-5042002-abcdef12-7",
    });
    expect(order.orderId).toBe("12345678901");
    expect(decodePayload(sent[0]?.headers["x-gemini-payload"])).toEqual({
      request: "/v1/prediction-markets/order",
      nonce: NOW / 1000,
      symbol: "GEMI-BTC2611202200-HI67000",
      orderType: "limit",
      side: "buy",
      quantity: "125",
      price: "0.40",
      outcome: "no",
      timeInForce: "good-til-cancel",
      clientOrderId: "mandate-5042002-abcdef12-7",
    });
  });

  it("raises the nonce by one when two requests share a second, and keeps it to whole seconds", async () => {
    const { sent, fetch } = recording(() => json({ isTrader: true }));
    let now = NOW + 400;
    const gemini = client(fetch, () => now);
    await Promise.all([gemini.roles(), gemini.roles(), gemini.roles()]);
    now += 5_000;
    await gemini.roles();
    expect(sent.map((request) => decodePayload(request.headers["x-gemini-payload"]).nonce)).toEqual([
      NOW / 1000,
      NOW / 1000 + 1,
      NOW / 1000 + 2,
      NOW / 1000 + 5,
    ]);
  });
});

describe("where a signed request may go", () => {
  const credentials = { apiKey: KEY, apiSecret: SECRET };

  it("refuses production unless it is allowed explicitly", () => {
    expect(() => createGeminiPrivateClient({ environment: "production", credentials })).toThrow(/real money/);
    expect(
      createGeminiPrivateClient({ environment: "production", credentials, allowProduction: true })
        .environment,
    ).toBe("production");
  });

  it("sends a key only to Gemini or a loopback test server", () => {
    for (const url of [
      "https://example.com",
      "http://10.0.0.5:8655",
      "http://127.0.0.1:8655/v1",
      "http://user:pw@127.0.0.1:8655",
      "https://127.0.0.1:8655",
    ]) {
      expect(isLoopbackTestUrl(url)).toBe(false);
      expect(() =>
        createGeminiPrivateClient({ environment: "sandbox", credentials, testBaseUrl: url }),
      ).toThrow(/only to Gemini/);
    }
    expect(isLoopbackTestUrl("http://127.0.0.1:8655")).toBe(true);
    expect(isLoopbackTestUrl("http://localhost:8655/")).toBe(true);
  });

  it("refuses a blank key or secret before sending anything", () => {
    expect(() =>
      createGeminiPrivateClient({ environment: "sandbox", credentials: { apiKey: " ", apiSecret: SECRET } }),
    ).toThrow(/must both be set/);
  });
});

describe("what a failure says", () => {
  async function failure(gemini: GeminiPrivateClient, call: (g: GeminiPrivateClient) => Promise<unknown>) {
    try {
      await call(gemini);
    } catch (error) {
      if (isGeminiPrivateError(error)) return error;
      throw error;
    }
    throw new Error("expected a failure");
  }

  const cases: [string, number, unknown, string, boolean][] = [
    [
      "an unknown key",
      403,
      { result: "error", reason: "InvalidApiKey", message: "Invalid API key" },
      "auth",
      false,
    ],
    ["a wrong secret", 400, { result: "error", reason: "InvalidSignature", message: "x" }, "auth", false],
    ["a stale nonce", 400, { result: "error", reason: "InvalidNonce", message: "x" }, "nonce", false],
    ["a missing role", 403, { result: "error", reason: "MissingRole", message: "x" }, "auth", false],
    [
      "terms not accepted",
      403,
      {
        error: "TERMS_NOT_ACCEPTED",
        message: "Prediction markets terms must be accepted before placing orders",
      },
      "terms",
      false,
    ],
    [
      "a blocked account",
      403,
      { error: "This account is not permitted", code: "ACCOUNT_GROUP_BLOCKED" },
      "account",
      false,
    ],
    [
      "insufficient funds",
      422,
      { error: "InsufficientFunds", message: "Insufficient funds" },
      "rejected",
      false,
    ],
    ["an invalid order", 400, { error: "InvalidInput", message: "price" }, "rejected", false],
    ["rate limiting", 429, { result: "error", reason: "RateLimit" }, "rate_limited", false],
    ["an outage", 503, { error: "SERVICE_UNAVAILABLE" }, "unavailable", true],
    ["a server error", 500, "oops", "unavailable", true],
  ];

  it.each(cases)("%s", async (_, status, body, kind, unknown) => {
    const { fetch } = recording(() => json(body, status));
    const error = await failure(client(fetch), (g) =>
      g.placeOrder({ symbol: "GEMI-X-Y", side: "buy", outcome: "yes", quantity: "1", price: "0.50" }),
    );
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.outcomeUnknown).toBe(unknown);
    expect(error.message).not.toContain(SECRET);
  });

  it("calls a timeout and a lost connection an unknown outcome, not a refusal", async () => {
    const timeout = recording(() => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    });
    const timedOut = await failure(client(timeout.fetch), (g) => g.roles());
    expect(timedOut).toMatchObject({ kind: "timeout", outcomeUnknown: true });

    const reset = recording(() => {
      throw new TypeError("fetch failed");
    });
    expect(await failure(client(reset.fetch), (g) => g.roles())).toMatchObject({
      kind: "network",
      outcomeUnknown: true,
    });
  });

  it("calls a success with an unexpected body an unknown outcome", async () => {
    const { fetch } = recording(() => json({ surprise: true }, 201));
    const error = await failure(client(fetch), (g) =>
      g.placeOrder({ symbol: "GEMI-X-Y", side: "buy", outcome: "yes", quantity: "1", price: "0.50" }),
    );
    expect(error).toMatchObject({ kind: "invalid_response", outcomeUnknown: true });
  });

  it("refuses an order id too large to keep exactly", async () => {
    const { fetch } = recording(
      () =>
        new Response(
          '{"orders":[{"orderId":123456789012345678901,"status":"open","symbol":"S","side":"buy","outcome":"yes","quantity":"1","price":"0.5"}]}',
        ),
    );
    const error = await failure(client(fetch), (g) => g.activeOrders("S"));
    expect(error.kind).toBe("invalid_response");
  });
});

describe("against the fake Gemini", () => {
  it("places, lists, fills, cancels and settles the way the fake's checks expect", async () => {
    let now = NOW;
    const fake = new FakeGeminiPrivate({ apiKey: KEY, apiSecret: SECRET, now: () => now });
    const gemini = client(fake.fetch, () => now);
    const symbol = "GEMI-BTC2611202200-HI67000";
    const placed = await gemini.placeOrder({
      symbol,
      side: "buy",
      outcome: "no",
      quantity: "10",
      price: "0.40",
      clientOrderId: "c-1",
    });
    expect(placed).toMatchObject({ status: "open", clientOrderId: "c-1", filledQuantity: "0" });
    expect(await gemini.activeOrders(symbol)).toHaveLength(1);

    now += 1_000;
    fake.fill(placed.orderId, 400, 38);
    expect((await gemini.activeOrders(symbol))[0]).toMatchObject({
      filledQuantity: "4",
      avgExecutionPrice: "0.3800",
    });
    await gemini.cancelOrder(placed.orderId);
    expect(await gemini.activeOrders(symbol)).toEqual([]);
    expect((await gemini.orderHistory(symbol))[0]).toMatchObject({
      status: "cancelled",
      filledQuantity: "4",
    });

    fake.settle(symbol, "no", "BTC2611202200");
    expect(await gemini.settledPositions()).toEqual([
      expect.objectContaining({
        instrumentSymbol: symbol,
        outcome: "no",
        positionQuantity: "4",
        payout: "4.00",
        resolutionSide: "no",
      }),
    ]);
  });

  it("is refused by the fake with a wrong secret, as Gemini would", async () => {
    const fake = new FakeGeminiPrivate({ apiKey: KEY, apiSecret: "another secret" });
    await expect(client(fake.fetch).roles()).rejects.toMatchObject({
      kind: "auth",
      reason: "InvalidSignature",
    });
  });
});

describe("the trading settings", () => {
  it("default to the sandbox and read the key pair", () => {
    expect(geminiTradingSettings({ GEMINI_API_KEY: " k ", GEMINI_API_SECRET: "s" })).toEqual({
      environment: "sandbox",
      allowProduction: false,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    expect(geminiTradingSettings({ GEMINI_API_KEY: "k" }).credentials).toBeNull();
  });

  it("need a second setting for production", () => {
    expect(() => geminiTradingSettings({ GEMINI_ENV: "production" })).toThrow(
      /GEMINI_LIVE_TRADING is not on/,
    );
    expect(geminiTradingSettings({ GEMINI_ENV: "production", GEMINI_LIVE_TRADING: "on" })).toMatchObject({
      environment: "production",
      allowProduction: true,
    });
    expect(() => geminiTradingSettings({ GEMINI_ENV: "sandbox", GEMINI_LIVE_TRADING: "yes" })).toThrow(
      /"on" or unset/,
    );
    expect(() => geminiTradingSettings({ GEMINI_ENV: "live" })).toThrow(/sandbox or production/);
  });

  it("never echo a key or secret in an error", () => {
    try {
      geminiTradingSettings({ GEMINI_ENV: "production", GEMINI_API_KEY: KEY, GEMINI_API_SECRET: SECRET });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("tell an account key from a master key by its documented prefix", () => {
    expect(keyScope("account-abc")).toBe("account");
    expect(keyScope("master-abc")).toBe("master");
    expect(keyScope("abc")).toBe("unknown");
  });
});
