import "server-only";

import {
  type Intent,
  type PolicyEvent,
  type PolicyViewState,
  type Roles,
  PolicyClient,
  ZERO_HASH,
  applyEvents,
  decisionContextSchema,
  decodePolicyLogs,
  emptyPolicyViewState,
  intentsMissingDetails,
  listIntents,
  lossTodayCents,
  mergeIntentDetails,
  reduceEvents,
  toSafeNumber,
  verifyContext,
} from "@mandate/shared";
import type { EnvVars, ResolvedDeployment } from "@mandate/shared/node";
import type { StreamBatch } from "@mandate/streams";
import { type Address, type Hex, type Log, createPublicClient, http, isAddressEqual } from "viem";

import type {
  ChainView,
  ConsoleNetwork,
  ConsoleSnapshot,
  ContractInfo,
  ContractKind,
  FeedHealth,
  FeedStatus,
  SealedReason,
} from "@/lib/live/types";
import { OWNER_REQUEST_MAX_AGE_MS } from "@/lib/owner-request";

import type { ConsoleConfig } from "./config";
import type { Database } from "./db";
import { type ChainClient, LogScanner, blockTimestamps, findDeployBlock } from "./ingest/chain-reader";
import { UNCONFIGURED_NETWORK, deploymentFileStamp, resolveDeployment } from "./ingest/deployment";
import { StreamReceiver } from "./ingest/stream";
import { EventStore, type IngestSource } from "./store/events";
import { OffchainStore } from "./store/offchain";

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const consoleLogger: Logger = {
  info: (message) => console.info(`[console] ${message}`),
  warn: (message) => console.warn(`[console] ${message}`),
};

/** One connection to one deployed Policy contract. A new deployment (or a reset devchain) is a new session. */
interface Session {
  /** chain id, address, deploy block and its hash: a reset devchain at the same address is a new id. */
  id: string;
  deployment: ResolvedDeployment;
  network: ConsoleNetwork;
  kind: ContractKind | null;
  client: ChainClient;
  policy: PolicyClient;
  scanner: LogScanner;
  deployBlock: bigint;
  fileStamp: number | null;
}

const ROLES_REFRESH_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** With the Stream as the primary source, the RPC only checks for gaps this often. */
const STREAM_SAFETY_POLL_MS = 15_000;
/** The Stream emits empty batches, so this long without a delivery means it is late or paused. */
const STREAM_STALE_MS = 30_000;

/**
 * The console backend: one pipeline from Policy contract logs to the state every view renders.
 *
 * Sources: the RPC (backfill from the deploy block, then polling) and the QuickNode Stream webhook both
 * hand decoded events to `ingest`, which stores them idempotently and folds them into the shared
 * reducer's state. Listeners (the server-sent events route) get a fresh snapshot after every change.
 *
 * It survives restarts: the event cache and the scan cursor are in SQLite, so a restart rebuilds the
 * same state and reads only the blocks it missed. A devchain restarted at the same address is detected
 * by the deploy block's hash and starts from scratch.
 */
export class ConsoleService {
  readonly events: EventStore;
  readonly offchain: OffchainStore;
  readonly stream: StreamReceiver;

  private session: Session | null = null;
  private network: ConsoleNetwork = UNCONFIGURED_NETWORK;
  private state: PolicyViewState = emptyPolicyViewState();
  private details = new Map<number, Intent>();
  private head: { blockNumber: number; timestamp: number } | null = null;
  private roles: Roles | null = null;
  private recordsContextHash: boolean | null = null;
  private rolesReadAt = 0;
  private feed: FeedStatus;
  private lastStreamAt = 0;

  private seq = 0;
  private snapshotCache: ConsoleSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: ConsoleSnapshot) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    readonly config: ConsoleConfig,
    db: Database,
    private readonly options: { env?: EnvVars; logger?: Logger } = {},
  ) {
    this.events = new EventStore(db);
    this.offchain = new OffchainStore(db);
    this.stream = new StreamReceiver(config.streamSecurityToken);
    this.feed = {
      source: config.eventSource,
      health: "starting",
      detail: "Connecting to the chain.",
      lastEventAt: null,
      lastSyncAt: null,
      syncedBlock: null,
    };
  }

  private get env(): EnvVars {
    return this.options.env ?? process.env;
  }

  private get log(): Logger {
    return this.options.logger ?? consoleLogger;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts reading the chain in the background. Calling it again does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop;
    this.loop = null;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }

  /** Resolves once the console has read the chain up to its head at least once, or the timeout passes. */
  async whenSynced(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.feed.health === "live" || this.feed.health === "lagging") return true;
      await sleep(25);
    }
    return false;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const resolution = resolveDeployment(this.env);
        if (!resolution.ok) {
          this.closeSession();
          this.network = resolution.network;
          this.setFeed({ health: "unconfigured", detail: resolution.detail, syncedBlock: null });
          await sleep(1_000, signal);
          continue;
        }
        this.network = resolution.network;
        const session = await this.openSession(resolution.deployment, resolution.kind, resolution.fileStamp);
        failures = 0;
        await this.follow(session, signal);
      } catch (error) {
        if (isAborted(signal)) return;
        failures += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures - 1, 5));
        this.setFeed({ health: "offline", detail: offlineDetail(error, this.network, delay) });
        if (failures === 1 || failures % 10 === 0) this.log.warn(`chain read failed: ${errorMessage(error)}`);
        await sleep(delay, signal);
      }
    }
  }

  private async openSession(
    deployment: ResolvedDeployment,
    kind: ContractKind | null,
    fileStamp: number | null,
  ): Promise<Session> {
    const client = createPublicClient({
      chain: deployment.chain,
      // One HTTP request for reads issued together; retries are this service's job, with backoff.
      transport: http(deployment.rpcUrl, { batch: { wait: 0 }, retryCount: 0, timeout: 10_000 }),
    });
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    const deployBlock =
      deployment.fromBlock ??
      (this.session?.deployment.address === deployment.address
        ? this.session.deployBlock
        : await findDeployBlock(client, deployment.address, latest));
    const deployHash = (await client.getBlock({ blockNumber: deployBlock })).hash;
    const id = `${String(deployment.chain.id)}:${deployment.address.toLowerCase()}:${deployBlock.toString()}:${deployHash}`;

    if (this.session?.id === id) {
      this.session = { ...this.session, fileStamp };
      return this.session;
    }

    const policy = new PolicyClient({ address: deployment.address, publicClient: client });
    const session: Session = {
      id,
      deployment,
      network: this.network,
      kind,
      client,
      policy,
      scanner: new LogScanner(client, deployment.address, {
        maxRange: deployment.source === "devchain" ? 10_000n : 5_000n,
        minRange: 50n,
      }),
      deployBlock,
      fileStamp,
    };
    this.closeSession();
    this.session = session;
    this.state = reduceEvents(this.events.list(id));
    this.details = this.events.intentDetails(id);
    this.head = null;
    this.roles = null;
    this.rolesReadAt = 0;
    this.recordsContextHash = null;
    this.log.info(
      `reading Policy ${deployment.address} on ${this.network.name} from block ${deployBlock.toString()} ` +
        `(${String(this.state.events.length)} events cached)`,
    );
    this.setFeed({ health: "starting", detail: "Reading the contract's history." });
    void policy.getCapabilities().then(
      (capabilities) => {
        if (this.session?.id !== id) return;
        this.recordsContextHash = capabilities.proposeWithContext;
        this.changed();
      },
      () => undefined,
    );
    return session;
  }

  /** Whether `session` is still the one being followed (another may have replaced it across an await). */
  private isCurrent(session: Session): boolean {
    return this.session === session;
  }

  private closeSession(): void {
    if (!this.session) return;
    this.session = null;
    this.state = emptyPolicyViewState();
    this.details = new Map();
    this.head = null;
    this.roles = null;
    this.recordsContextHash = null;
    this.changed();
  }

  /** Backfills, then polls until the deployment changes or a read fails. */
  private async follow(session: Session, signal: AbortSignal): Promise<void> {
    const primaryRpc = this.config.eventSource === "rpc";
    const interval =
      this.config.pollIntervalMs > 0
        ? this.config.pollIntervalMs
        : session.deployment.source === "devchain"
          ? 250
          : 1_000;
    while (!signal.aborted && this.session === session) {
      if (session.deployment.source === "devchain" && deploymentFileStamp(this.env) !== session.fileStamp) {
        return; // dev:chain restarted or stopped: resolve the deployment again
      }
      const block = await session.client.getBlock({ blockTag: "latest" });
      const latest = block.number;
      let cursor = this.events.cursor(session.id) ?? session.deployBlock;
      if (latest + 1n < cursor) {
        this.log.warn("the chain is behind the console's cursor; it was reset, reading it again");
        return;
      }
      this.head = {
        blockNumber: toSafeNumber(latest, "block"),
        timestamp: toSafeNumber(block.timestamp, "timestamp"),
      };

      while (cursor <= latest && !isAborted(signal) && this.isCurrent(session)) {
        const chunk = session.scanner.nextChunk(cursor, latest);
        const events = await session.scanner.read(chunk);
        const added = this.events.insertScanned(session.id, events, chunk.to + 1n);
        cursor = chunk.to + 1n;
        this.apply(added);
        if (cursor <= latest) {
          this.setFeed({
            health: "starting",
            detail: `Reading the contract's history: block ${cursor.toString()} of ${latest.toString()}.`,
            syncedBlock: Number(cursor - 1n),
          });
        }
      }

      await this.fillIntentDetails(session);
      await this.refreshRoles(session);
      this.markSynced(Number(latest), primaryRpc);
      await sleep(primaryRpc ? interval : Math.max(interval, STREAM_SAFETY_POLL_MS), signal);
    }
  }

  private markSynced(block: number, primaryRpc: boolean): void {
    let health: FeedHealth = "live";
    let detail = primaryRpc
      ? `Polling the chain every ${this.pollDescription()}.`
      : "Receiving the QuickNode Stream; the RPC checks for gaps.";
    if (!primaryRpc && Date.now() - this.lastStreamAt > STREAM_STALE_MS) {
      health = "lagging";
      detail =
        this.lastStreamAt === 0
          ? "No Stream delivery yet. The RPC poller keeps the console current every 15 s."
          : "No Stream delivery for over 30 s. The RPC poller keeps the console current every 15 s.";
    }
    this.setFeed({ health, detail, lastSyncAt: new Date().toISOString(), syncedBlock: block });
  }

  private pollDescription(): string {
    const ms =
      this.config.pollIntervalMs > 0
        ? this.config.pollIntervalMs
        : this.session?.deployment.source === "devchain"
          ? 250
          : 1_000;
    return ms < 1_000 ? `${String(ms)} ms` : `${String(ms / 1_000)} s`;
  }

  // ---------------------------------------------------------------- the pipeline

  /** Folds newly stored events into the state. Every source ends here. */
  private apply(added: readonly PolicyEvent[]): void {
    if (added.length === 0) return;
    this.state = applyEvents(this.state, added);
    this.changed();
  }

  /**
   * Stores a verified Stream delivery and applies its events. Logs from other contracts and removed logs
   * are ignored. Returns how many events were new.
   */
  async ingestStreamBatch(batch: StreamBatch): Promise<{ received: number; stored: number } | null> {
    const session = this.session;
    if (!session) return null;
    this.lastStreamAt = Date.now();
    const logs = batch.logs.filter(
      (log) => !log.removed && isAddressEqual(log.address, session.deployment.address),
    ) as unknown as Log[];
    let stored = 0;
    if (logs.length > 0) {
      const events = decodePolicyLogs(logs, {
        address: session.deployment.address,
        blockTimestamps: await blockTimestamps(session.client, logs),
      });
      const added = this.events.insert(session.id, events, "stream");
      stored = added.length;
      this.apply(added);
      await this.fillIntentDetails(session).catch(() => undefined);
    }
    if (this.config.eventSource === "stream" && this.feed.health === "lagging") {
      this.setFeed({ health: "live", detail: "Receiving the QuickNode Stream; the RPC checks for gaps." });
    } else {
      this.changed();
    }
    return { received: logs.length, stored };
  }

  /** Test seam and internal entry for decoded events from any source. */
  ingestEvents(events: readonly PolicyEvent[], source: IngestSource): number {
    const session = this.session;
    if (!session) return 0;
    const added = this.events.insert(session.id, events, source);
    this.apply(added);
    return added.length;
  }

  /** Reads `getIntent` for intents no event described (the production contract has no `IntentProposed`). */
  private async fillIntentDetails(session: Session): Promise<void> {
    const missing = intentsMissingDetails(this.state).filter((id) => !this.details.has(id));
    if (missing.length === 0) return;
    const read: Intent[] = [];
    for (let start = 0; start < missing.length; start += 20) {
      const ids = missing.slice(start, start + 20);
      const intents = await Promise.all(ids.map((id) => session.policy.getIntent(id)));
      for (const intent of intents) if (intent) read.push(intent);
    }
    if (this.session !== session) return;
    this.events.saveIntentDetails(session.id, read);
    for (const intent of read) this.details.set(intent.id, intent);
    if (read.length > 0) this.changed();
  }

  private async refreshRoles(session: Session): Promise<void> {
    if (this.roles && Date.now() - this.rolesReadAt < ROLES_REFRESH_MS) return;
    const roles = await session.policy.getRoles();
    if (this.session !== session) return;
    this.rolesReadAt = Date.now();
    const changed =
      !this.roles ||
      !isAddressEqual(this.roles.user, roles.user) ||
      !isAddressEqual(this.roles.agent, roles.agent) ||
      !isAddressEqual(this.roles.executor, roles.executor);
    this.roles = roles;
    if (changed) this.changed();
  }

  /** Roles as last read, reading them now when the console has none yet. Null when the chain is unreachable. */
  async currentRoles(): Promise<Roles | null> {
    if (this.roles) return this.roles;
    const session = this.session;
    if (!session) return null;
    try {
      await this.refreshRoles(session);
    } catch {
      return null;
    }
    return this.roles;
  }

  /** Single-use nonces of owner-signed requests, with when they may be forgotten. */
  private readonly ownerNonces = new Map<string, number>();

  /** True the first time a nonce is presented within the replay window, false on any reuse. */
  claimOwnerNonce(nonce: string, now: () => number = Date.now): boolean {
    const time = now();
    for (const [seen, expires] of this.ownerNonces) if (expires <= time) this.ownerNonces.delete(seen);
    if (this.ownerNonces.has(nonce)) return false;
    this.ownerNonces.set(nonce, time + 2 * OWNER_REQUEST_MAX_AGE_MS);
    return true;
  }

  /** Whether `owner` signed `message`. Works for plain wallets and, through the chain, smart accounts. */
  async verifyOwnerSignature(owner: Address, message: string, signature: Hex): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    try {
      return await session.client.verifyMessage({ address: owner, message, signature });
    } catch {
      return false;
    }
  }

  /** The read-only client of the live deployment, or null while there is none. */
  get policyClient(): PolicyClient | null {
    return this.session?.policy ?? null;
  }

  get policyAddress(): `0x${string}` | null {
    return this.session?.deployment.address ?? null;
  }

  // ---------------------------------------------------------------- snapshots

  private setFeed(patch: Partial<FeedStatus>): void {
    const next = { ...this.feed, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.feed)) return;
    this.feed = next;
    this.changed();
  }

  /** Marks the state changed and tells listeners soon after; bursts of changes become one message. */
  changed(): void {
    this.snapshotCache = null;
    if (this.notifyTimer || this.listeners.size === 0) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    }, 20);
  }

  subscribe(listener: (snapshot: ConsoleSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ConsoleSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
    this.seq += 1;
    const session = this.session;
    const lastEvent = this.state.events.at(-1);
    const contract: ContractInfo | null = session
      ? {
          address: session.deployment.address,
          deployBlock: Number(session.deployBlock),
          kind: session.kind,
          roles: this.roles,
          recordsContextHash: this.recordsContextHash,
        }
      : null;
    const pairing = this.offchain.latestPairing();
    const holdings = this.offchain.holdings();
    const plan = this.offchain.latestPlan();
    this.snapshotCache = {
      seq: this.seq,
      network: this.network,
      feed: {
        ...this.feed,
        lastEventAt: lastEvent ? new Date(lastEvent.blockTimestamp * 1000).toISOString() : null,
      },
      contract,
      chain: session && this.head ? this.chainView(this.head) : null,
      offchain: {
        holdings: holdings.holdings,
        holdingsUpdatedAt: holdings.updatedAt,
        pairing: pairing
          ? {
              agentAddress: pairing.agentAddress,
              agentName: pairing.agentName,
              serverVersion: pairing.serverVersion,
              status: pairing.status,
              announcedAt: pairing.announcedAt,
              confirmedAt: pairing.confirmedAt,
              isContractAgent: this.roles ? isAddressEqual(this.roles.agent, pairing.agentAddress) : false,
            }
          : null,
        changeRequests: this.offchain.changeRequests(),
        latestPlan: plan ? { planId: plan.planId, asset: plan.asset, storedAt: plan.storedAt } : null,
      },
      mcpPublicUrl: this.config.mcpPublicUrl,
    };
    return this.snapshotCache;
  }

  private chainView(head: { blockNumber: number; timestamp: number }): ChainView {
    const state = this.state;
    const intents = listIntents(state).map((intent) => {
      const stored = this.details.get(intent.id);
      return stored && (intent.market === null || intent.category === null)
        ? mergeIntentDetails(intent, stored)
        : intent;
    });
    const policyEvents = state.events.filter((event) => event.type === "PolicyUpdated");
    const lastPolicy = policyEvents.at(-1);
    return {
      head,
      rules: state.rules,
      paused: state.paused,
      committedCents: state.committedCents,
      lossTodayCents: lossTodayCents(state, head.timestamp),
      realizedPnlCents: state.realizedPnlCents,
      rejectionsByReason: state.rejectionsByReason,
      counts: state.counts,
      intents,
      events: state.events,
      policyVersion: policyEvents.length,
      policySetBy: lastPolicy
        ? {
            blockNumber: lastPolicy.blockNumber,
            timestamp: lastPolicy.blockTimestamp,
            txHash: lastPolicy.transactionHash,
          }
        : null,
      sealed: this.sealedReasons(intents),
    };
  }

  /** Checks each recorded context hash against the document stored for it. */
  private sealedReasons(
    intents: readonly { id: number; contextHash: Hex | null }[],
  ): Record<number, SealedReason> {
    const sealed: Record<number, SealedReason> = {};
    const withHash = intents.filter(
      (intent): intent is { id: number; contextHash: Hex } =>
        intent.contextHash !== null && intent.contextHash.toLowerCase() !== ZERO_HASH,
    );
    const stored = this.offchain.contexts(withHash.map((intent) => intent.contextHash));
    for (const intent of withHash) {
      const context = stored.get(intent.contextHash.toLowerCase());
      if (!context) {
        sealed[intent.id] = { status: "not_stored", hash: intent.contextHash };
        continue;
      }
      const document = decisionContextSchema.safeParse(context.document);
      sealed[intent.id] =
        document.success && verifyContext(document.data, intent.contextHash)
          ? {
              status: "verified",
              hash: intent.contextHash,
              document: document.data,
              storedAt: context.storedAt,
            }
          : { status: "tampered", hash: intent.contextHash, storedAt: context.storedAt };
    }
    return sealed;
  }
}

// ------------------------------------------------------------------ helpers

/** Reads `signal.aborted` afresh: it can flip during any await, which control-flow narrowing ignores. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" ? short : (error.message.split("\n")[0] ?? error.name);
  }
  return String(error);
}

function offlineDetail(error: unknown, network: ConsoleNetwork, delayMs: number): string {
  const retry = `Retrying in ${String(Math.round(delayMs / 1000))} s.`;
  const message = errorMessage(error);
  if (/fetch failed|ECONNREFUSED|HTTP request failed|timed out|took too long/i.test(message)) {
    const where = network.kind === "local" ? ` at ${network.rpcUrl}` : "";
    const hint = network.kind === "local" ? " Is `npm run dev:chain` running?" : "";
    return `Can't reach ${network.name}${where}.${hint} ${retry}`;
  }
  return `Reading the chain failed: ${message}. ${retry}`;
}
