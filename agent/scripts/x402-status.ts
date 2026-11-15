/**
 * Prints wallet and Gateway balances for the x402 buyer and seller, and the buyer's recent Gateway transfers.
 * Only public addresses are printed.
 */
import { GatewayClient, type TransferResponse } from "@circle-fin/x402-batching/client";
import { explorerAddressUrl, explorerTxUrl, loadEnv, requireEnv } from "@mandate/shared";
import type { Hex } from "viem";

loadEnv();

const roles = [
  {
    role: "buyer",
    client: new GatewayClient({
      chain: "arcTestnet",
      privateKey: requireEnv("X402_BUYER_PRIVATE_KEY") as Hex,
    }),
  },
  {
    role: "seller",
    client: new GatewayClient({
      chain: "arcTestnet",
      privateKey: requireEnv("X402_SELLER_PRIVATE_KEY") as Hex,
    }),
  },
];

for (const { role, client } of roles) {
  const balances = await client.getBalances();
  console.log(`${role} ${client.address} ${explorerAddressUrl(client.address)}`);
  console.log(`  wallet USDC ${balances.wallet.formatted}`);
  console.log(
    `  gateway total ${balances.gateway.formattedTotal}, available ${balances.gateway.formattedAvailable}, ` +
      `withdrawing ${balances.gateway.formattedWithdrawing}`,
  );
}

const buyer = roles[0]?.client;
if (buyer) {
  const { transfers } = await buyer.searchTransfers({ from: buyer.address, pageSize: 10 });
  console.log(`buyer transfers (latest ${transfers.length}):`);
  for (const transfer of transfers) printTransfer(transfer);
}

function printTransfer(transfer: TransferResponse): void {
  const txHash = typeof transfer.txHash === "string" ? explorerTxUrl(transfer.txHash) : "not settled yet";
  console.log(
    `  ${transfer.createdAt} ${transfer.status} ${transfer.amount} base units to ${transfer.toAddress} id ${transfer.id} ${txHash}`,
  );
}
