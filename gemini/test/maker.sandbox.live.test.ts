/**
 * The mirror maker on Gemini's real sandbox with both accounts (opt-in): the maker quotes today's daily
 * ladder from production's books, the executor's account buys 1 NO against the maker's YES bid on one
 * rung, both accounts report the fill, their positions on that rung move by one contract each, and the
 * maker cancels everything it left. It also answers whether Gemini's self-trade prevention stops a match
 * between two accounts of one person: if it does, the NO buy does not fill and the test says so.
 *
 * Skipped unless MAKER_INTEGRATION=1. Reads GEMINI_MAKER_API_KEY/SECRET and GEMINI_API_KEY/SECRET from the
 * environment (or the env file `ENV_FILE` names) and prints none of them. Spends about $1 of test funds.
 *
 *   MAKER_INTEGRATION=1 ENV_FILE=<path> npx vitest run gemini/test/maker.sandbox.live.test.ts
 *
 * First run on 18 November 2026, by hand, before this file existed: the maker's YES bid of 1 at 52c on
 * GEMI-BTC2611182200-HI64250 was taken by the executor account's NO buy at 48c at once; positions YES 1 and
 * NO 1; no self-trade prevention across the two accounts.
 */
import { loadEnv } from "@mandate/shared";
import { describe, expect, it } from "vitest";
import { createGeminiClient } from "../src/index";
import { GEMINI_HOSTS } from "../src/environment";
import { MirrorMaker } from "../src/maker/maker";
import { makerSettings } from "../src/maker/settings";
import { createGeminiPrivateClient, type GeminiPrivateClient } from "../src/private";
import { toHundredths } from "../src/units";

const ENABLED = process.env["MAKER_INTEGRATION"] === "1";

async function held(client: GeminiPrivateClient, symbol: string, outcome: "yes" | "no"): Promise<number> {
  const positions = await client.positions();
  return positions
    .filter((position) => position.symbol === symbol && position.outcome.toLowerCase() === outcome)
    .reduce((sum, position) => sum + (toHundredths(position.totalQuantity) ?? 0), 0);
}

describe.skipIf(!ENABLED)("the mirror maker on Gemini's sandbox, with both accounts (opt-in)", () => {
  it(
    "is taken by the executor account's NO buy, and both accounts see the fill",
    { timeout: 120_000 },
    async () => {
      loadEnv();
      const settings = makerSettings(process.env);
      const executorKey = process.env.GEMINI_API_KEY?.trim() ?? "";
      const executorSecret = process.env.GEMINI_API_SECRET?.trim() ?? "";
      if (executorKey === "" || executorSecret === "")
        throw new Error("GEMINI_API_KEY and GEMINI_API_SECRET are not set");
      const makerAccount = createGeminiPrivateClient({
        environment: "sandbox",
        credentials: settings.credentials,
      });
      const executor = createGeminiPrivateClient({
        environment: "sandbox",
        credentials: { apiKey: executorKey, apiSecret: executorSecret },
      });
      const lines: string[] = [];
      const maker = new MirrorMaker({
        production: createGeminiClient({ baseUrl: GEMINI_HOSTS.production }),
        sandbox: createGeminiClient({ baseUrl: GEMINI_HOSTS.sandbox }),
        account: makerAccount,
        settings: {
          ...settings,
          kinds: ["daily"],
          // Small quotes: this is a test of the match, not of depth.
          limits: { ...settings.limits, maxQuoteHundredths: 200, maxRestingNotionalCents: 3_000 },
        },
        say: (line) => {
          lines.push(line);
          console.info(`[maker] ${line}`);
        },
      });
      let orderId: string | null = null;
      try {
        await maker.cancelAll();
        // Production's public API answers a 500 now and then: a few cycles, as the running maker would.
        let placed = 0;
        for (let i = 0; i < 4 && placed === 0; i += 1) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
          placed += (await maker.cycle()).placed;
        }
        expect(placed).toBeGreaterThan(0);
        const view = await maker.view();
        const bid = view.resting.find((quote) => quote.outcome === "yes");
        if (!bid) throw new Error(`the maker has no YES bid resting: ${lines.join(" | ")}`);
        const makerBefore = await held(makerAccount, bid.symbol, "yes");
        const executorBefore = await held(executor, bid.symbol, "no");
        const order = await executor.placeOrder({
          symbol: bid.symbol,
          side: "buy",
          outcome: "no",
          quantity: "1",
          price: `0.${String(100 - bid.priceCents).padStart(2, "0")}`,
          clientOrderId: `itest-${Date.now().toString(36)}`,
        });
        orderId = order.orderId;
        console.info(
          `[executor] NO buy 1 at ${String(100 - bid.priceCents)}c on ${bid.symbol}: ${order.status}, filled ${String(order.filledQuantity)}`,
        );
        let filled = toHundredths(order.filledQuantity ?? "0") ?? 0;
        for (let i = 0; i < 10 && filled < 100; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const history = await executor.orderHistory(bid.symbol);
          filled =
            toHundredths(history.find((entry) => entry.orderId === orderId)?.filledQuantity ?? "0") ?? 0;
        }
        if (filled < 100) {
          throw new Error(
            "The executor account's NO buy did not fill against the maker's YES bid: Gemini's self-trade prevention, " +
              "or something else, keeps the two accounts from matching. Stop and report.",
          );
        }
        expect(await held(makerAccount, bid.symbol, "yes")).toBe(makerBefore + 100);
        expect(await held(executor, bid.symbol, "no")).toBe(executorBefore + 100);
        const makerHistory = await makerAccount.orderHistory(bid.symbol);
        expect(
          makerHistory.some(
            (entry) =>
              entry.orderId === bid.orderId && (toHundredths(entry.filledQuantity ?? "0") ?? 0) >= 100,
          ) ||
            (await maker.view()).resting.some(
              (quote) => quote.orderId === bid.orderId && quote.remainingHundredths < 200,
            ),
        ).toBe(true);
      } finally {
        if (orderId !== null && (await executor.activeOrders()).some((entry) => entry.orderId === orderId)) {
          await executor.cancelOrder(orderId);
        }
        await maker.cancelAll();
        expect(
          (await makerAccount.activeOrders()).filter((entry) => entry.clientOrderId?.startsWith("mk-")),
        ).toEqual([]);
      }
    },
  );
});
