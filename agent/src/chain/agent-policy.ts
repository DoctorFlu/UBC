/**
 * The agent's access to the Policy contract: reads, a preview and `proposeTrade`, nothing else.
 *
 * `PolicyClient` from `@mandate/shared` also has the owner's and the executor's writes. It is held
 * in a private field and only the methods below touch it, so the rest of the server sees the
 * narrow `AgentPolicy` interface. `test/no-owner-calls.test.ts` scans the source to keep it so.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  chainExplorerTxUrl,
  devchain,
  PolicyClient,
  signerAccount,
  type AgentSigner,
  type Capabilities,
  type Intent,
  type IntentView,
  type PolicySnapshot,
  type PreviewResult,
  type ProposeResult,
  type Roles,
  type RuleInput,
  type TradeIntentInput,
} from "@mandate/shared";
import type { Address, Config } from "../config";
import type { AgentPolicy } from "../services";
import { EventIndex } from "./event-index";

/** A loopback RPC is the local devchain (anvil): no explorer, and receipts arrive in milliseconds. */
function isLoopback(rpcUrl: string): boolean {
  const host = new URL(rpcUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export class ChainAgentPolicy implements AgentPolicy {
  readonly policyAddress: Address;
  readonly agentAddress: Address | undefined;
  readonly #client: PolicyClient;
  readonly #publicClient: PublicClient<Transport, Chain>;
  readonly #chain: Chain;
  readonly #events: EventIndex;

  constructor(options: {
    policyAddress: Address;
    publicClient: PublicClient<Transport, Chain>;
    walletClient?: WalletClient<Transport, Chain, Account>;
    deployBlock?: bigint;
    /** Skip probing for these contract extensions (tests). */
    capabilities?: Partial<Capabilities>;
  }) {
    this.policyAddress = options.policyAddress;
    this.agentAddress = options.walletClient?.account.address;
    this.#publicClient = options.publicClient;
    this.#chain = options.publicClient.chain;
    this.#client = new PolicyClient({
      address: options.policyAddress,
      publicClient: options.publicClient,
      ...(options.walletClient === undefined ? {} : { walletClient: options.walletClient }),
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      receiptTimeoutMs: 45_000,
    });
    this.#events = new EventIndex(this.#client, options.deployBlock);
  }

  capabilities(): Promise<Capabilities> {
    return this.#client.getCapabilities();
  }

  snapshot(): Promise<PolicySnapshot> {
    return this.#client.getSnapshot();
  }

  roles(): Promise<Roles> {
    return this.#client.getRoles();
  }

  async agentGasBalance(): Promise<bigint | null> {
    if (this.agentAddress === undefined) return null;
    return this.#publicClient.getBalance({ address: this.agentAddress });
  }

  intentCount(): Promise<number> {
    return this.#client.getIntentCount();
  }

  intent(id: number): Promise<Intent | null> {
    return this.#client.getIntent(id);
  }

  async intentEvents(): Promise<ReadonlyMap<number, IntentView>> {
    return this.#events.intents();
  }

  preview(input: RuleInput): Promise<PreviewResult> {
    return this.#client.previewTrade(input);
  }

  async propose(input: TradeIntentInput): Promise<ProposeResult> {
    if (this.agentAddress === undefined)
      throw new Error("No agent key is configured, so nothing can be proposed");
    return this.#client.proposeTrade(input);
  }

  explorerTxUrl(txHash: `0x${string}`): string | null {
    return chainExplorerTxUrl(this.#chain, txHash);
  }
}

/**
 * The policy service for this configuration, or undefined when no Policy contract is configured. It signs
 * with `signer` when one is given (an agent key the console holds), else with `AGENT_PRIVATE_KEY`.
 */
export function createAgentPolicy(config: Config, signer?: AgentSigner): AgentPolicy | undefined {
  if (config.policyAddress === undefined) return undefined;
  const rpcUrl = config.arcRpcUrl.reveal();
  const local = isLoopback(rpcUrl);
  const chain: Chain = local ? { ...devchain, rpcUrls: { default: { http: [rpcUrl] } } } : arcTestnet;
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 1 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: local ? 100 : 1_000 });
  const key = config.agentPrivateKey;
  const account =
    signer !== undefined
      ? signerAccount(signer)
      : key === undefined
        ? undefined
        : privateKeyToAccount(key.reveal());
  const walletClient = account === undefined ? undefined : createWalletClient({ chain, transport, account });
  return new ChainAgentPolicy({
    policyAddress: config.policyAddress,
    publicClient,
    ...(walletClient === undefined ? {} : { walletClient }),
    ...(config.policyDeployBlock === undefined ? {} : { deployBlock: config.policyDeployBlock }),
  });
}
