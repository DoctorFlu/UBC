/**
 * The one test that sends signed requests to Gemini (issue #93), and only to the sandbox: the client is
 * built for the sandbox host, so a production key is refused there and nothing reaches production.
 * Skipped unless GEMINI_SANDBOX_TEST=1. It reads GEMINI_API_KEY and GEMINI_API_SECRET from the
 * environment (or the repository's .env) and prints neither:
 *
 *   GEMINI_SANDBOX_TEST=1 npx vitest run gemini/test/sandbox.live.test.ts
 *
 * Run `npm run gemini:doctor` first, and make this the first order a new sandbox key ever sends. It
 * places one order of 1 contract at 1 cent (one cent at most, the smallest order Gemini takes), far from any
 * market, and cancels it. It checks what the docs leave open: whether the REST API takes and returns our client order
 * id, the shape of an order in the active and history lists, and the order states.
 */
import { loadEnv } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { createGeminiClient } from "../src/index";
import { createGeminiPrivateClient, GEMINI_HOSTS, type PrivateOrder } from "../src/private";
import { isGeminiPrivateError } from "../src/private-errors";
import { geminiTradingSettings } from "../src/private-settings";

const ENABLED = process.env["GEMINI_SANDBOX_TEST"] === "1";

describe.skipIf(!ENABLED)("Gemini's sandbox, with a key (opt-in)", () => {
  it("places one tiny order with our client order id, finds it, and cancels it", async () => {
    loadEnv();
    const settings = geminiTradingSettings(process.env);
    if (settings.environment !== "sandbox") throw new Error("GEMINI_ENV must be sandbox for this test");
    if (settings.credentials === null) throw new Error("GEMINI_API_KEY and GEMINI_API_SECRET are not set");
    // The raw answers of the order routes, printed whole: the parsed order drops fields the docs do not
    // list (a fee, say). They hold order data only; the key and secret travel in request headers.
    const trading = createGeminiPrivateClient({
      environment: "sandbox",
      credentials: settings.credentials,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const path = new URL(input).pathname;
        if (path.startsWith("/v1/prediction-markets/order")) {
          console.info(
            `[sandbox] raw ${path} (HTTP ${String(response.status)}): ${await response.clone().text()}`,
          );
        }
        return response;
      },
    });

    const roles = await trading.roles();
    expect(roles.isTrader, "the key needs the Trader role").toBe(true);
    const terms = await trading.termsStatus();
    expect(terms.hasAcceptedLatest, "accept the Prediction Markets terms on the sandbox site first").toBe(
      true,
    );

    // Any contract the sandbox trades: the soonest BTC ladder's first active strike.
    const market = createGeminiClient({ baseUrl: GEMINI_HOSTS.sandbox, maxRetries: 1 });
    const [listing] = await market.listLadders("BTC");
    if (listing === undefined) throw new Error("the sandbox lists no BTC ladder");
    const event = await market.getEvent(listing.eventTicker);
    const contract = event.contracts.find((candidate) => candidate.status === "active");
    if (contract === undefined) throw new Error(`no active contract on ${listing.eventTicker}`);
    const symbol = contract.instrumentSymbol;

    const clientOrderId = `mandate-sandbox-test-${String(Date.now())}`;
    let placed: PrivateOrder;
    try {
      placed = await trading.placeOrder({
        symbol,
        side: "buy",
        outcome: "yes",
        // Gemini refuses an order that costs less than one cent ("Order cost must be at least 0.01"), so
        // this is the smallest order it takes: 1 contract at 1 cent.
        quantity: "1",
        price: "0.01",
        clientOrderId,
      });
    } catch (error) {
      if (isGeminiPrivateError(error) && error.kind === "rejected") {
        throw new Error(
          `Gemini refused the order (${error.message}). If the reason names clientOrderId, the REST API ` +
            "does not take it and the executor must stop sending it.",
          { cause: error },
        );
      }
      throw error;
    }
    let cancelled = false;
    try {
      console.info(
        `[sandbox] placed order ${placed.orderId} on ${symbol}: status ${placed.status}, ` +
          `client order id returned: ${placed.clientOrderId === clientOrderId ? "yes" : `no (${String(placed.clientOrderId)})`}`,
      );
      const active = await trading.activeOrders(symbol);
      const listed = active.find((order) => order.orderId === placed.orderId);
      expect(listed, "the order is among the active orders").toBeDefined();
      console.info(
        `[sandbox] active order: status ${String(listed?.status)}, client order id returned: ` +
          (listed?.clientOrderId === clientOrderId ? "yes" : "no"),
      );

      await trading.cancelOrder(placed.orderId);
      cancelled = true;
      const history = await trading.orderHistory(symbol);
      const closed = history.find((order) => order.orderId === placed.orderId);
      expect(closed, "the cancelled order is in the history").toBeDefined();
      console.info(`[sandbox] after cancel: status ${String(closed?.status)}`);
      expect(closed?.clientOrderId, "Gemini returns our client order id").toBe(clientOrderId);
    } finally {
      if (!cancelled) await trading.cancelOrder(placed.orderId).catch(() => undefined);
    }
  }, 60_000);
});
