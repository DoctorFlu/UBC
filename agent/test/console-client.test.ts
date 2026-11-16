import { describe, expect, it } from "vitest";
import { CONSOLE_AGENT_ROUTES, hashContext, type DecisionContext } from "@mandate/shared";
import {
  ConsoleClientError,
  createConsoleClient,
  HttpConsoleClient,
  type FetchLike,
} from "../src/console/client";
import { Secret } from "../src/secret";
import { createFakeConsole } from "../testing/fake-console";
import { TEST_ADDRESS, testConfig } from "./helpers";

const TOKEN = "console-token-for-wire-tests";

function client(fetchImpl: FetchLike, token = TOKEN) {
  return new HttpConsoleClient({
    baseUrl: "http://console.test/",
    token: new Secret(token),
    fetch: fetchImpl,
  });
}

const document: DecisionContext = {
  version: 1,
  requestText: "Protect my BTC",
  planId: "plan_0123456789abcdef",
  rungIndex: 0,
  ladderSummary: {
    eventTicker: "BTC2611202200",
    observedAt: "2026-11-15T12:00:00.000Z",
    rungs: [
      {
        instrumentSymbol: "GEMI-BTC2611202200-HI63000",
        label: "$63,000 or above",
        yesBidCents: 70,
        yesAskCents: 72,
      },
    ],
  },
  signalReceiptIds: [],
  reason: "Owner asked.",
  createdAt: "2026-11-15T12:00:00.000Z",
};

describe("HttpConsoleClient against the wire contract", () => {
  it("round-trips every route through a console built on the same schemas", async () => {
    const fake = createFakeConsole({ token: TOKEN, holdings: [{ asset: "BTC", quantity: "0.05" }] });
    const c = client(fake.clientFetch);
    const hash = hashContext(document);

    expect(await c.getHoldings()).toMatchObject({ holdings: [{ asset: "BTC", quantity: "0.05" }] });
    expect(await c.putContext(hash, document)).toMatchObject({ hash, document });
    expect(await c.getContext(hash)).toMatchObject({ hash });
    expect(await c.getContext(`0x${"1".repeat(64)}`)).toBeNull();
    expect(
      await c.postPlan({
        planId: "plan_1",
        asset: "BTC",
        requestText: "r",
        createdAt: "2026-11-15T12:00:00.000Z",
        plan: { a: 1 },
      }),
    ).toMatchObject({ planId: "plan_1" });
    const request = await c.postPolicyChangeRequest({
      agentAddress: TEST_ADDRESS,
      proposed: { maxTradeCents: 5_000 },
      reason: "why",
    });
    expect(request).toMatchObject({ status: "pending", proposed: { maxTradeCents: 5_000 } });
    expect(await c.getPairing()).toBeNull();
    expect(
      await c.putPairing({ agentAddress: TEST_ADDRESS, agentName: "Grok Bot", serverVersion: "0.0.0" }),
    ).toMatchObject({ status: "pending" });
    expect(await c.getPairing()).toMatchObject({ agentAddress: TEST_ADDRESS });

    expect(fake.state.requests).toContain(`GET ${CONSOLE_AGENT_ROUTES.holdings}`);
  });

  it("links an intent to its context idempotently and maps a different hash to conflict", async () => {
    const fake = createFakeConsole({ token: TOKEN });
    const c = client(fake.clientFetch);
    const hash = hashContext(document);
    const txHash = `0x${"c".repeat(64)}` as const;

    expect(await c.putIntentContext(3, { hash, txHash })).toMatchObject({ intentId: 3, hash, txHash });
    expect(await c.putIntentContext(3, { hash, txHash })).toMatchObject({ intentId: 3, hash });
    expect(fake.state.requests).toContain(`PUT ${CONSOLE_AGENT_ROUTES.intentContext(3)}`);
    await expect(c.putIntentContext(3, { hash: `0x${"d".repeat(64)}`, txHash })).rejects.toMatchObject({
      constructor: ConsoleClientError,
      kind: "conflict",
      status: 409,
      code: "conflict",
    });
    expect(fake.state.intentContexts.get(3)?.hash).toBe(hash);
  });

  it("records signal payments once per receipt id, and reads a missing route as null", async () => {
    const fake = createFakeConsole({ token: TOKEN });
    const c = client(fake.clientFetch);
    const receiptId = `0x${"9".repeat(64)}`;
    const payment = {
      amount: "1000",
      paidAt: "2026-11-15T12:00:01.000Z",
      resource: "/v1/signal/hedge?asset=BTC&horizon=weekly",
      network: "eip155:5042002",
      payer: TEST_ADDRESS,
      payee: null,
      settlementId: null,
      signal: null,
    } as const;
    const budget = {
      buyerAddress: TEST_ADDRESS,
      day: "2026-11-15",
      dailyBudget: "20000",
      spentToday: "1000",
      maxPricePerPurchase: "5000",
      resetsAt: "2026-11-16T00:00:00.000Z",
      gatewayBalance: null,
      asOf: "2026-11-15T12:00:02.000Z",
    } as const;

    const first = await c.putSignalPayment(receiptId, payment);
    expect(first).toMatchObject({ receiptId });
    expect(await c.putSignalPayment(receiptId, { ...payment, amount: "2" })).toEqual(first);
    expect(fake.state.signalPayments.get(receiptId)?.amount).toBe("1000");
    expect(await c.putSignalBudget(budget)).toMatchObject({ spentToday: "1000" });
    expect(fake.state.requests).toContain(`PUT ${CONSOLE_AGENT_ROUTES.signalPayment(receiptId)}`);

    fake.setSignalRoutes(false);
    expect(await c.putSignalPayment(receiptId, payment)).toBeNull();
    expect(await c.putSignalBudget(budget)).toBeNull();
    await expect(c.putSignalPayment(receiptId, { ...payment, amount: "0.001" })).rejects.toThrow();
  });

  it("sends the bearer token and maps 401 to unauthorized", async () => {
    const fake = createFakeConsole({ token: TOKEN });
    await expect(client(fake.clientFetch, "wrong-token").getHoldings()).rejects.toMatchObject({
      constructor: ConsoleClientError,
      kind: "unauthorized",
      status: 401,
    });
  });

  it("maps 422 to rejected with the console's code and message", async () => {
    const fake = createFakeConsole({ token: TOKEN });
    const wrongHash = `0x${"2".repeat(64)}` as const;
    await expect(client(fake.clientFetch).putContext(wrongHash, document)).rejects.toMatchObject({
      kind: "rejected",
      code: "hash_mismatch",
      message: "The document does not hash to the hash in the path.",
    });
  });

  it("refuses to send a body that breaks the contract, before any request", async () => {
    const fake = createFakeConsole({ token: TOKEN });
    await expect(
      client(fake.clientFetch).postPolicyChangeRequest({
        agentAddress: TEST_ADDRESS,
        proposed: { paused: false } as never,
        reason: "unpause",
      }),
    ).rejects.toThrow();
    expect(fake.state.requests).toHaveLength(0);
  });

  it("reports drift in the console's answers as bad_response", async () => {
    const drifted: FetchLike = () =>
      Promise.resolve(Response.json({ holdings: [{ asset: "BTC", qty: 1 }], updatedAt: null }));
    await expect(client(drifted).getHoldings()).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("reports a refused connection, a timeout and a 5xx as unreachable", async () => {
    const refused: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    await expect(client(refused).getHoldings()).rejects.toMatchObject({ kind: "unreachable" });

    const slow: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const impatient = new HttpConsoleClient({
      baseUrl: "http://c",
      token: new Secret(TOKEN),
      fetch: slow,
      timeoutMs: 20,
    });
    await expect(impatient.getHoldings()).rejects.toMatchObject({ kind: "unreachable" });

    const broken: FetchLike = () => Promise.resolve(new Response("oops", { status: 502 }));
    await expect(client(broken).getHoldings()).rejects.toMatchObject({ kind: "unreachable", status: 502 });
  });

  it("never puts the token in an error", async () => {
    const refused: FetchLike = () => Promise.reject(new TypeError(`fetch failed`));
    const error = await client(refused)
      .getHoldings()
      .catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("exists only when a service token is configured", () => {
    expect(createConsoleClient(testConfig())).toBeUndefined();
    expect(createConsoleClient(testConfig({ CONSOLE_SERVICE_TOKEN: TOKEN }))?.baseUrl).toBe(
      "http://localhost:3000",
    );
  });
});
