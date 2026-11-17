/**
 * `npm run gemini:sandbox-orders [-- --cancel <orderId>] [--balances] [--raw]`: the open orders of the
 * Gemini SANDBOX account whose key is in `.env` (or `ENV_FILE`), and, with `--cancel`, cancels one of them
 * by its exact id. `--balances` adds the account's USD balance (to see what an order really cost, fees
 * included), and `--raw` prints Gemini's own answer for the recent orders, every field, as it came.
 *
 * Sandbox only, whatever GEMINI_ENV says: the client is built for the sandbox host, so a production key is
 * refused there and nothing reaches production. It prints order and balance data only, never the key or
 * the secret. Use it to check that a sandbox run left no order behind.
 */
import { parseArgs } from "node:util";
import { loadEnv } from "@mandate/shared";
import { createGeminiPrivateClient, type PrivateOrder } from "../src/private";
import { geminiTradingSettings } from "../src/private-settings";

const { values } = parseArgs({
  options: {
    cancel: { type: "string" },
    balances: { type: "boolean", default: false },
    raw: { type: "boolean", default: false },
  },
});

loadEnv();
const { credentials } = geminiTradingSettings({ ...process.env, GEMINI_ENV: "sandbox" });
if (credentials === null) {
  console.error("GEMINI_API_KEY and GEMINI_API_SECRET must both be set.");
  process.exit(1);
}
/** Gemini's answer to the history request, as text, for --raw. Answers carry no key or secret. */
const raw: { history: string | null } = { history: null };
const sandbox = createGeminiPrivateClient({
  environment: "sandbox",
  credentials,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(input).pathname === "/v1/prediction-markets/orders/history") {
      raw.history = await response.clone().text();
    }
    return response;
  },
});

const describe = (order: PrivateOrder) =>
  `  #${order.orderId} ${order.symbol} ${order.side} ${order.outcome} ${order.quantity} at ${order.price}: ` +
  `${order.status}, filled ${order.filledQuantity ?? "?"}` +
  (order.avgExecutionPrice ? ` at ${order.avgExecutionPrice}` : "") +
  (order.clientOrderId ? `, client id ${order.clientOrderId}` : "");

if (values.cancel !== undefined) {
  await sandbox.cancelOrder(values.cancel);
  console.log(`Asked the sandbox to cancel order #${values.cancel}.`);
}

if (values.balances) {
  for (const balance of await sandbox.balances()) {
    if (balance.currency.toUpperCase() !== "USD") continue;
    console.log(`USD balance: amount ${balance.amount}, available ${balance.available}`);
  }
}

const open = await sandbox.activeOrders();
console.log(`Open orders on Gemini's sandbox: ${String(open.length)}`);
for (const order of open) console.log(describe(order));
const history = await sandbox.orderHistory();
console.log(`Most recent closed orders (${String(history.length)}):`);
for (const order of history.slice(0, 10)) console.log(describe(order));
if (values.raw && raw.history !== null) {
  const rows = JSON.parse(raw.history) as unknown;
  console.log("Gemini's answer for the 3 most recent closed orders, as sent:");
  console.log(JSON.stringify(Array.isArray(rows) ? rows.slice(0, 3) : rows, null, 2));
}
