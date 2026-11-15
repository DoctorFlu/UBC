/**
 * Makes one paid x402 request to the local signals seller and prints the receipt.
 *
 *   npm run start -w @mandate/signals          # in one terminal
 *   npm run x402:hello -w @mandate/agent       # in another; add -- --wait-settlement to follow the batch onchain
 *
 * Reads X402_BUYER_PRIVATE_KEY from ENV_FILE (default: repository root .env). Never prints the key.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { explorerTxUrl, loadEnv, requireEnv } from "@mandate/shared";
import { formatUnits, type Hex } from "viem";
import { X402Buyer } from "../src/x402/buyer";

loadEnv();
const url = process.env.X402_HELLO_URL ?? "http://localhost:4021/v1/signal/hello";
const maxPrice = process.env.X402_MAX_PRICE ?? "0.001";
const depositAmount = process.env.X402_DEPOSIT_USDC ?? "1";
const waitForSettlement = process.argv.includes("--wait-settlement");

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: requireEnv("X402_BUYER_PRIVATE_KEY") as Hex,
});
const buyer = new X402Buyer(client);
console.log(`buyer ${buyer.address}`);

const deposit = await buyer.ensureDeposit({ minAvailable: maxPrice, depositAmount });
if (deposit.deposited) {
  if (deposit.approvalTxHash) console.log(`approve ${explorerTxUrl(deposit.approvalTxHash)}`);
  if (deposit.depositTxHash) console.log(`deposit ${explorerTxUrl(deposit.depositTxHash)}`);
  console.log(`deposit credited by Gateway after ${deposit.creditedAfterMs} ms`);
}
console.log(`gateway available before: ${formatUnits(deposit.available, 6)} USDC`);

const paid = await buyer.pay(url, { maxPrice });
console.log(`status ${paid.status}`);
console.log(`data ${JSON.stringify(paid.data)}`);
console.log(`receipt ${JSON.stringify(paid.receipt, null, 2)}`);

if (waitForSettlement && paid.receipt) {
  const receipt = paid.receipt;
  const started = Date.now();
  let last = "";
  for (;;) {
    const transfer = await buyer.transferFor(receipt);
    const status = transfer?.status ?? "not found";
    if (status !== last) {
      console.log(`+${Math.round((Date.now() - started) / 1000)}s transfer ${transfer?.id ?? "-"} ${status}`);
      last = status;
    }
    const txHash = transfer?.txHash;
    if (typeof txHash === "string" && txHash.length > 0) {
      console.log(`batch settlement ${explorerTxUrl(txHash)}`);
      if (status === "completed" || status === "failed") break;
    }
    if (status === "failed") break;
    if (Date.now() - started > 20 * 60_000) {
      console.log("gave up after 20 minutes; check later with npm run x402:status");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
