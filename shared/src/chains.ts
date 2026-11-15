import { defineChain, type Chain, type Hex } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET } from "./arc";

/** Arc testnet, as shipped by viem: chain id 5042002, USDC as the native gas token (18 decimals). */
export { arcTestnet };

export const ARC_TESTNET_CHAIN_ID = ARC_TESTNET.chainId;

export const DEVCHAIN_RPC_URL = "http://127.0.0.1:8545";

/**
 * Local anvil chain started by `npm run dev:chain`. It uses Arc testnet's chain id so that code paths that
 * check the chain id behave the same locally. It has no explorer and no multicall contract.
 */
export const devchain = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Mandate devchain",
  nativeCurrency: arcTestnet.nativeCurrency,
  rpcUrls: { default: { http: [DEVCHAIN_RPC_URL] } },
  testnet: true,
});

/** Base URL of the chain's block explorer, or null when it has none (the devchain). */
export function chainExplorerBaseUrl(chain: Chain): string | null {
  const url = chain.blockExplorers?.default.url;
  return url ? url.replace(/\/+$/, "") : null;
}

export function chainExplorerTxUrl(chain: Chain, txHash: Hex): string | null {
  const base = chainExplorerBaseUrl(chain);
  return base ? `${base}/tx/${txHash}` : null;
}

export function chainExplorerAddressUrl(chain: Chain, address: Hex): string | null {
  const base = chainExplorerBaseUrl(chain);
  return base ? `${base}/address/${address}` : null;
}

export function chainExplorerBlockUrl(chain: Chain, blockNumber: bigint | number): string | null {
  const base = chainExplorerBaseUrl(chain);
  return base ? `${base}/block/${blockNumber.toString()}` : null;
}
