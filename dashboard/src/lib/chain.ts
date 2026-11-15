/**
 * Chain config for the console.
 *
 * TODO(@mandate/shared): this moves to `@mandate/shared` when that package lands; it is defined
 * locally for now so the dashboard does not depend on a package still being built.
 *
 * Both chains share Arc testnet's chain id, so a wallet pointed at either sees the same id.
 * `NEXT_PUBLIC_CHAIN` picks one: "arc-testnet" (default) or "local" (anvil on 127.0.0.1:8545).
 */
import { defineChain } from "viem";

export const ARC_TESTNET_CHAIN_ID = 5042002;

const nativeCurrency = {
  // Arc's gas token is USDC. As the native currency it uses 18 decimals, unlike the 6-decimal ERC-20.
  name: "USDC",
  symbol: "USDC",
  decimals: 18,
} as const;

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc testnet",
  nativeCurrency,
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc explorer", url: "https://explorer.testnet.arc.io" } },
  testnet: true,
});

export const localDevChain = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Local dev chain",
  nativeCurrency,
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export type ChainKey = "arc-testnet" | "local";

export function resolveChainKey(value: string | undefined): ChainKey {
  return value === "local" ? "local" : "arc-testnet";
}

export const chainKey: ChainKey = resolveChainKey(process.env.NEXT_PUBLIC_CHAIN);

/** The one chain the console talks to. */
export const targetChain = chainKey === "local" ? localDevChain : arcTestnet;

/** Explorer base URL, or undefined on the local chain, which has no explorer. */
export const explorerUrl: string | undefined = targetChain.blockExplorers?.default.url;

export function explorerTxUrl(hash: string): string | undefined {
  return explorerUrl ? `${explorerUrl}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(address: string): string | undefined {
  return explorerUrl ? `${explorerUrl}/address/${address}` : undefined;
}

export function explorerBlockUrl(block: number | bigint): string | undefined {
  return explorerUrl ? `${explorerUrl}/block/${block.toString()}` : undefined;
}
