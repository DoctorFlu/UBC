/**
 * Test-only local signer, so end-to-end tests and local demos need no browser extension.
 *
 * Enabled only when the build sets NEXT_PUBLIC_DEV_SIGNER=1 (see ./flags.ts). It signs with
 * anvil's default account #0.
 *
 * THIS IS A PUBLIC TEST KEY. Every `anvil` start prints it and Foundry's docs publish it; anyone
 * can sign with it. Never send real funds to its address on any network.
 */
import {
  type Chain,
  type EIP1193RequestFn,
  type Hex,
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  http,
  numberToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConnector } from "wagmi";

import { DEV_SIGNER_ID } from "./flags";

/**
 * Anvil account #0. Public test key: see the warning at the top of this file.
 *
 * The literal sits behind the inlined flag itself, not behind an imported constant: Next.js
 * replaces `process.env.NEXT_PUBLIC_DEV_SIGNER` at build time, so without the flag this folds to
 * `undefined` and the key never reaches a bundle. `npm run e2e` does not check this; the README
 * gives the one-line grep that does.
 */
const ANVIL_ACCOUNT_0_PUBLIC_TEST_KEY: Hex | undefined =
  process.env.NEXT_PUBLIC_DEV_SIGNER === "1"
    ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    : undefined;

interface TxRequest {
  to?: Hex;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
  nonce?: Hex;
}

/** A minimal EIP-1193 provider: signs locally, forwards reads to the chain's RPC. */
function createDevProvider(chain: Chain) {
  if (!ANVIL_ACCOUNT_0_PUBLIC_TEST_KEY) {
    throw new Error("The dev signer needs a build made with NEXT_PUBLIC_DEV_SIGNER=1.");
  }
  const account = privateKeyToAccount(ANVIL_ACCOUNT_0_PUBLIC_TEST_KEY);
  const transport = http(chain.rpcUrls.default.http[0]);
  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const request = (async ({ method, params }: { method: string; params?: unknown }) => {
    const args = (params ?? []) as unknown[];
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "eth_chainId":
        return numberToHex(chain.id);
      case "wallet_switchEthereumChain": {
        const [{ chainId }] = args as [{ chainId: Hex }];
        if (Number(chainId) !== chain.id)
          throw new Error(`Dev signer only supports chain ${chain.id.toString()}`);
        return null;
      }
      case "personal_sign": {
        const [message] = args as [Hex];
        return account.signMessage({ message: { raw: message } });
      }
      case "eth_signTypedData_v4": {
        const [, typedData] = args as [Hex, string];
        return account.signTypedData(JSON.parse(typedData) as Parameters<typeof account.signTypedData>[0]);
      }
      case "eth_sendTransaction": {
        const [tx] = args as [TxRequest];
        return walletClient.sendTransaction({
          to: tx.to ?? null,
          ...(tx.data ? { data: tx.data } : {}),
          ...(tx.value ? { value: hexToBigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
        });
      }
      default:
        return publicClient.request({ method, params } as Parameters<typeof publicClient.request>[0]);
    }
  }) as EIP1193RequestFn;

  return { account, provider: { request } };
}

type DevProvider = ReturnType<typeof createDevProvider>["provider"];

export function devSigner(chain: Chain) {
  const { account, provider } = createDevProvider(chain);
  let connected = false;

  return createConnector<DevProvider>((config) => ({
    id: DEV_SIGNER_ID,
    name: "Dev signer",
    type: DEV_SIGNER_ID,
    // wagmi's Connector type declares connect as generic over withCapabilities; keep the signature.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    async connect<withCapabilities extends boolean = false>() {
      connected = true;
      // The dev signer has no capabilities, so the plain address list fits both result shapes.
      const accounts = [account.address] as unknown as withCapabilities extends true
        ? readonly { address: Hex; capabilities: Record<string, unknown> }[]
        : readonly Hex[];
      return Promise.resolve({ accounts, chainId: chain.id });
    },
    async disconnect() {
      connected = false;
      return Promise.resolve();
    },
    async getAccounts() {
      return Promise.resolve([account.address]);
    },
    async getChainId() {
      return Promise.resolve(chain.id);
    },
    async getProvider() {
      return Promise.resolve(provider);
    },
    async isAuthorized() {
      return Promise.resolve(connected);
    },
    async switchChain({ chainId }) {
      if (chainId !== chain.id) throw new Error(`Dev signer only supports chain ${chain.id.toString()}`);
      return Promise.resolve(chain);
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      connected = false;
      config.emitter.emit("disconnect");
    },
  }));
}
