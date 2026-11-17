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
import { raceAbort } from "@mandate/shared";
import { type Address, type Config, isLoopbackUrl } from "../config";
import type { AgentPolicy, ProposeOptions } from "../services";
import { EventIndex } from "./event-index";
import { scopedFetch, shieldCurrentScope, unscoped, withSignal } from "./rpc-scope";

/**
 * Most a proposal waits for its receipt once it is broadcast. Arc confirms in about a second; a
 * transaction still unconfirmed after this is reported as `TX_UNCONFIRMED`, and nothing sends it again.
 */
export const RECEIPT_TIMEOUT_MS = 10_000;

/** A loopback RPC is the local devchain (anvil): no explorer, and receipts arrive in milliseconds. */
const isLoopback = isLoopbackUrl;

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
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
    });
    this.#events = new EventIndex(this.#client, options.deployBlock);
  }

  /**
   * Runs one read with its RPC requests aborted when `signal` aborts, and stops waiting for it at
   * once then (viem may still be between retries).
   */
  #read<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal === undefined) return work();
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    return raceAbort(
      withSignal(signal, () => work()),
      signal,
    );
  }

  /**
   * Which extensions the contract has, detected once for the process. The probes count any failure as
   * "no extension", so they never run under one caller's signal: an aborted probe would be cached as a
   * wrong answer for good. The caller only stops waiting.
   */
  #capabilities(signal: AbortSignal | undefined): Promise<Capabilities> {
    return raceAbort(
      unscoped(() => this.#client.getCapabilities()),
      signal,
    );
  }

  capabilities(signal?: AbortSignal): Promise<Capabilities> {
    return this.#capabilities(signal);
  }

  snapshot(signal?: AbortSignal): Promise<PolicySnapshot> {
    return this.#read(signal, () => this.#client.getSnapshot());
  }

  roles(signal?: AbortSignal): Promise<Roles> {
    return this.#read(signal, () => this.#client.getRoles());
  }

  async agentGasBalance(signal?: AbortSignal): Promise<bigint | null> {
    const address = this.agentAddress;
    if (address === undefined) return null;
    return this.#read(signal, () => this.#publicClient.getBalance({ address }));
  }

  intentCount(signal?: AbortSignal): Promise<number> {
    return this.#read(signal, () => this.#client.getIntentCount());
  }

  intent(id: number, signal?: AbortSignal): Promise<Intent | null> {
    return this.#read(signal, () => this.#client.getIntent(id));
  }

  intentEvents(signal?: AbortSignal): Promise<ReadonlyMap<number, IntentView>> {
    return this.#read(signal, () => this.#events.intents(signal));
  }

  async preview(input: RuleInput, signal?: AbortSignal): Promise<PreviewResult> {
    await this.#capabilities(signal);
    return this.#read(signal, () => this.#client.previewTrade(input));
  }

  /**
   * Proposes one intent. `signal` stops it only before the broadcast (see `WriteOptions` in
   * `@mandate/shared`): this never races the signal, because a proposal that may be out must be
   * followed to its receipt and reported, not abandoned.
   */
  async propose(input: TradeIntentInput, options: ProposeOptions = {}): Promise<ProposeResult> {
    if (this.agentAddress === undefined)
      throw new Error("No agent key is configured, so nothing can be proposed");
    const { signal, beforeBroadcast } = options;
    await this.#capabilities(signal);
    const write = () =>
      this.#client.proposeTrade(input, {
        signal,
        beforeBroadcast: () => {
          const bound = beforeBroadcast?.();
          // From here on only the bound aborts the broadcast and the receipt polls, not `signal`.
          shieldCurrentScope(bound);
          return bound;
        },
      });
    return signal === undefined ? write() : withSignal(signal, write);
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
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 1, fetchFn: scopedFetch });
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
