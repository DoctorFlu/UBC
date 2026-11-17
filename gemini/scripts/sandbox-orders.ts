/**
 * `npm run gemini:sandbox-orders [-- --cancel <orderId>]`: the open orders of the Gemini SANDBOX account
 * whose key is in `.env` (or `ENV_FILE`), and, with `--cancel`, cancels one of them by its exact id.
 *
 * Sandbox only, whatever GEMINI_ENV says: the client is built for the sandbox host, so a production key is
 * refused there and nothing reaches production. It prints order data only, never the key or the secret.
 * Use it to check that a sandbox run left no order behind.
 */
import { parseArgs } from "node:util";
import { loadEnv } from "@mandate/shared";
import { createGeminiPrivateClient, type PrivateOrder } from "../src/private";
import { geminiTradingSettings } from "../src/private-settings";

const { values } = parseArgs({ options: { cancel: { type: "string" } } });

loadEnv();
const { credentials } = geminiTradingSettings({ ...process.env, GEMINI_ENV: "sandbox" });
if (credentials === null) {
  console.error("GEMINI_API_KEY and GEMINI_API_SECRET must both be set.");
  process.exit(1);
}
const sandbox = createGeminiPrivateClient({ environment: "sandbox", credentials });

const describe = (order: PrivateOrder) =>
  `  #${order.orderId} ${order.symbol} ${order.side} ${order.outcome} ${order.quantity} at ${order.price}: ` +
  `${order.status}, filled ${order.filledQuantity ?? "?"}${order.clientOrderId ? `, client id ${order.clientOrderId}` : ""}`;

if (values.cancel !== undefined) {
  await sandbox.cancelOrder(values.cancel);
  console.log(`Asked the sandbox to cancel order #${values.cancel}.`);
}

const open = await sandbox.activeOrders();
console.log(`Open orders on Gemini's sandbox: ${String(open.length)}`);
for (const order of open) console.log(describe(order));
const history = await sandbox.orderHistory();
console.log(`Most recent closed orders (${String(history.length)}):`);
for (const order of history.slice(0, 10)) console.log(describe(order));
