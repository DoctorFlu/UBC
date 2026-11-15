/**
 * Arc testnet and Circle Gateway constants used by the x402 seller, the buyer and the dashboard.
 * Every value here was checked against the live network or Circle's docs on 2026-11-15 (see docs/x402.md).
 */
export const ARC_TESTNET = {
  chainId: 5042002,
  /** CAIP-2 id that x402 uses in `network` fields. */
  network: "eip155:5042002",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  /** ERC-20 interface to native USDC. It uses 6 decimals; the native gas balance uses 18. */
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  /** Circle Gateway Wallet: holds buyer deposits and receives the batched settlement transactions. */
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  /** Circle Gateway domain id for Arc. */
  gatewayDomain: 26,
  /** Circle Gateway API for testnets: x402 verify, settle, supported, balances and transfers. */
  gatewayApiUrl: "https://gateway-api-testnet.circle.com",
} as const;

export function explorerTxUrl(hash: string): string {
  return `${ARC_TESTNET.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${ARC_TESTNET.explorerUrl}/address/${address}`;
}
