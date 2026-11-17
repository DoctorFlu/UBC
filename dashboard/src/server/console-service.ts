import "server-only";

import { type ListingLookup, ListingChecker, listingOrder } from "@mandate/gemini";
import {
  type Intent,
  type IntentView,
  type PolicyEvent,
  type PolicyViewState,
  type Roles,
  PolicyClient,
  ZERO_HASH,
  applyEvents,
  decisionContextSchema,
  decodePolicyLogs,
  emptyPolicyViewState,
  executorVenueSchema,
  hashExecutorRecord,
  hashSettlement,
  intentsMissingDetails,
  reduceEvents,
  settlementSchema,
  type StoredSettlement,
  toSafeNumber,
  venueOrderRecordSchema,
  verifyContext,
} from "@mandate/shared";
import type { EnvVars, ResolvedDeployment } from "@mandate/shared/node";
import type { StreamBatch } from "@mandate/streams";
import type { WakeFetch } from "@mandate/shared";
import { type Address, type Hex, type Log, createPublicClient, http, isAddressEqual } from "viem";

import type {
  ChainView,
  ConsoleNetwork,
  ConsoleSnapshot,
  ConsoleWakeStatus,
  ContractInfo,
  ContractKind,
  FeedHealth,
  FeedStatus,
  PairingView,
  SealedReason,
  SealedSource,
  SettlementView,
  VenueOrderView,
  ExecutorVenueView,
} from "@/lib/live/types";
import { readClaims } from "@/lib/evidence/claims";
import { readHedgePlan } from "@/lib/hedge/plan-schema";
import type { AgentPlanView } from "@/lib/hedge/types";
import { buildChainView } from "@/lib/live/chain-view";
import { OWNER_REQUEST_MAX_AGE_MS } from "@/lib/owner-request";

import { Accounts } from "./accounts/accounts";
import type { Mandate } from "./accounts/store";
import type { ConsoleConfig } from "./config";
import type { Database } from "./db";
import { type ChainClient, LogScanner, blockTimestamps, findDeployBlock } from "./ingest/chain-reader";
import { UNCONFIGURED_NETWORK, deploymentFileStamp, resolveDeployment } from "./ingest/deployment";
import { StreamReceiver } from "./ingest/stream";
import { EventStore, type IngestSource } from "./store/events";
import { ListingStore } from "./store/listings";
import {
  OffchainStore,
  type StoredIntentContextLink,
  type StoredPairing,
  type StoredPlan,
} from "./store/offchain";
import { TestClock } from "./test-clock";
import { ConsoleWake, type LadderSource, NO_WAKE_TARGET_REASON, wakeOffStatus } from "./wake";
import { type SettlementRow, SettlementStore } from "./store/settlements";
import { type SignedRow, type VenueOrderRow, VenueOrderStore } from "./store/venue-orders";

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/** What the service needs to know about a mandate: whose records, and whether it follows the chain. */
export type MandateScope = Pick<Mandate, "id" | "deployment">;

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
  /**
   * True while the console reads a deployment it had never read (no scan cursor when the session
   * opened), until its first sync: those events are history and wake nothing.
   */
  backfilling: boolean;
}

const ROLES_REFRESH_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** With the Stream as the primary source, the RPC only checks for gaps this often. */
const STREAM_SAFETY_POLL_MS = 15_000;
/** Longest a browser waits for a feed update that is not news (the synced block moving on). */
const QUIET_PUSH_MS = 10_000;
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
 *
 * Every view is of one mandate (docs/accounts.md): `snapshot`, `subscribe` and the offchain records take
 * the mandate they are for. The chain this service follows is the server's configured contract, which
 * only the mandate with deployment `env` sees; any other mandate sees no contract yet.
 */
export class ConsoleService {
  readonly events: EventStore;
  readonly offchain: OffchainStore;
  readonly accounts: Accounts;
  /** What filled positions paid at settlement, as the executor signed it (#92). */
  readonly settlements: SettlementStore;
  /** The executor's venue order journal and the venue it announced (#93). */
  readonly venueOrders: VenueOrderStore;
  readonly stream: StreamReceiver;
  /** Gemini's listing of each intent's market, when the console has a way to ask Gemini. */
  readonly listings: ListingChecker | null;
  /** Event wake-ups of the Grok Bot routine (issue #40); does nothing while they are off. */
  readonly wake: ConsoleWake;
  /** The wake-ups' clock when `GROK_WAKE_TEST_CLOCK=on`, which the end-to-end tests move; otherwise null. */
  readonly wakeClock: TestClock | null;

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
  /** Each mandate's latest snapshot, until the next change. */
  private readonly snapshotCache = new Map<string, ConsoleSnapshot>();
  /** The live streams, by mandate: each one hears only its own mandate's snapshots. */
  private readonly listeners = new Map<
    string,
    { mandate: MandateScope; listeners: Set<(snapshot: ConsoleSnapshot) => void> }
  >();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt = 0;

  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    readonly config: ConsoleConfig,
    db: Database,
    private readonly options: {
      env?: EnvVars;
      logger?: Logger;
      /** How to ask Gemini about a market, and the most times its client sends one request. */
      marketLookup?: { lookup: ListingLookup; attemptsPerRequest: number };
      /** Gemini's ladder for a goal, for the price wake-ups; without it, price is not checked. */
      ladder?: LadderSource;
      /** How wake-ups are posted; tests pass their own. */
      wakeFetch?: WakeFetch;
    } = {},
  ) {
    this.events = new EventStore(db);
    this.offchain = new OffchainStore(db);
    this.accounts = new Accounts(config.accounts, db, {
      dataDir: config.dataDir,
      log: (message) => this.log.info(message),
    });
    this.settlements = new SettlementStore(db);
    this.venueOrders = new VenueOrderStore(db);
    this.stream = new StreamReceiver(config.streamSecurityToken);
    this.listings = options.marketLookup
      ? new ListingChecker({
          ...options.marketLookup,
          store: new ListingStore(db),
          onChange: () => this.changed(),
          logger: this.log,
        })
      : null;
    this.wakeClock = config.wake.testClock ? new TestClock() : null;
    // One webhook, from the settings, for the mandate on the server's contract (docs/accounts.md).
    this.wake = new ConsoleWake(config, db, this.accounts.store.envMandate().id, {
      logger: this.log,
      onChange: () => {
        this.changed();
      },
      ...(this.wakeClock ? { now: this.wakeClock.now, schedule: this.wakeClock.schedule } : {}),
      ...(options.ladder ? { ladder: options.ladder } : {}),
      ...(options.wakeFetch ? { fetch: options.wakeFetch } : {}),
    });
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
    this.wake.start();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop;
    this.loop = null;
    this.listings?.stop();
    this.wake.stop();
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
    const backfilling = this.events.cursor(id) === null;
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
      backfilling,
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
        this.apply(added, session.backfilling);
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
      session.backfilling = false;
      // Price wake-ups ride on this loop: a check runs when the last is old enough, never more often.
      this.wake.tick(() => this.priceInputs());
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
    const skipped = this.session?.scanner.skipped.describe() ?? null;
    if (skipped !== null) {
      // Up to date, but not every event could be read: shown, never silent.
      health = "lagging";
      detail = skipped;
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

  /**
   * Folds newly stored events into the state and offers them to the wake-up rules. Every source ends
   * here, so a trigger fires once whichever source (RPC poll or QuickNode Stream) delivered its event.
   */
  private apply(added: readonly PolicyEvent[], history = false): void {
    if (added.length === 0) return;
    this.state = applyEvents(this.state, added);
    const session = this.session;
    if (session) {
      this.wake.onChainEvents(added, this.state.events, { deploymentId: session.id, history });
    }
    this.changed();
  }

  /** An agent of `mandate` called the console through its MCP server: that mandate's Bot run is in progress. */
  noteAgentActivity(mandate: MandateScope): void {
    if (mandate.id === this.wake.mandateId) this.wake.noteAgentActivity();
  }

  /** The wake-up status `mandate`'s owners see: off for every mandate the console sends none for. */
  private wakeStatus(mandate: MandateScope): ConsoleWakeStatus {
    return mandate.id === this.wake.mandateId
      ? this.wake.status()
      : wakeOffStatus(this.config, NO_WAKE_TARGET_REASON);
  }

  /** What a price check reads: the wake-up mandate's latest plans and holdings, and the intents. */
  private priceInputs() {
    const mandateId = this.wake.mandateId;
    const plans = this.offchain.latestPlans(mandateId).flatMap((stored) => {
      const view = toPlanView(stored);
      return view ? [view] : [];
    });
    const head = this.head;
    const intents = head ? buildChainView(this.state, head, this.details).intents : [];
    return { plans, holdings: this.offchain.holdings(mandateId).holdings, intents };
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
        onUndecodable: (log) => {
          session.scanner.skipped.note(log);
        },
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

  /**
   * Updates the feed status. A poll that only confirms the console is current (a new `lastSyncAt` or
   * `syncedBlock`, nothing else) is not news: it refreshes the snapshot for the next reader and reaches
   * browsers at most every `QUIET_PUSH_MS`, instead of pushing the whole snapshot on every poll.
   */
  private setFeed(patch: Partial<FeedStatus>): void {
    const next = { ...this.feed, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.feed)) return;
    const quiet = (feed: FeedStatus) => JSON.stringify({ ...feed, lastSyncAt: null, syncedBlock: null });
    const news = quiet(next) !== quiet(this.feed);
    this.feed = next;
    if (news || Date.now() - this.lastPushAt >= QUIET_PUSH_MS) this.changed();
    else this.snapshotCache.clear();
  }

  /**
   * Marks the state changed and tells listeners soon after; bursts of changes become one message. Every
   * mandate's listeners hear it, each with a snapshot of their own mandate.
   */
  changed(): void {
    this.snapshotCache.clear();
    if (this.notifyTimer || this.listeners.size === 0) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.lastPushAt = Date.now();
      for (const { mandate, listeners } of this.listeners.values()) {
        const snapshot = this.snapshot(mandate);
        for (const listener of listeners) listener(snapshot);
      }
    }, 20);
  }

  /** Listens for one mandate's snapshots. */
  subscribe(mandate: MandateScope, listener: (snapshot: ConsoleSnapshot) => void): () => void {
    const group = this.listeners.get(mandate.id) ?? { mandate, listeners: new Set() };
    group.listeners.add(listener);
    this.listeners.set(mandate.id, group);
    return () => {
      group.listeners.delete(listener);
      if (group.listeners.size === 0 && this.listeners.get(mandate.id) === group) {
        this.listeners.delete(mandate.id);
      }
    };
  }

  /** The chain feed's health, for the public health check: says nothing about any mandate. */
  get feedHealth(): FeedHealth {
    return this.feed.health;
  }

  /** Whether this mandate follows the contract this service reads. */
  private follows(mandate: MandateScope): boolean {
    return mandate.deployment === "env";
  }

  /** One mandate's state, as every view renders it. */
  snapshot(mandate: MandateScope): ConsoleSnapshot {
    const cached = this.snapshotCache.get(mandate.id);
    if (cached) return cached;
    this.seq += 1;
    const follows = this.follows(mandate);
    const session = follows ? this.session : null;
    const lastEvent = follows ? this.state.events.at(-1) : undefined;
    const contract: ContractInfo | null = session
      ? {
          address: session.deployment.address,
          deployBlock: Number(session.deployBlock),
          kind: session.kind,
          roles: this.roles,
          recordsContextHash: this.recordsContextHash,
        }
      : null;
    const pairing = this.offchain.latestPairing(mandate.id);
    const holdings = this.offchain.holdings(mandate.id);
    const plans = this.offchain.latestPlans(mandate.id).flatMap((stored) => {
      const view = toPlanView(stored);
      return view ? [view] : [];
    });
    const snapshot: ConsoleSnapshot = {
      seq: this.seq,
      network: follows ? this.network : UNCONFIGURED_NETWORK,
      feed: follows
        ? {
            ...this.feed,
            lastEventAt: lastEvent ? new Date(lastEvent.blockTimestamp * 1000).toISOString() : null,
          }
        : {
            source: this.config.eventSource,
            health: "unconfigured",
            detail: "This mandate has no Policy contract yet.",
            lastEventAt: null,
            lastSyncAt: null,
            syncedBlock: null,
          },
      contract,
      chain: session && this.head ? this.chainView(mandate, this.head) : null,
      offchain: {
        holdings: holdings.holdings,
        holdingsUpdatedAt: holdings.updatedAt,
        pairing: pairing ? this.toPairingView(pairing, follows) : null,
        changeRequests: this.offchain.changeRequests(mandate.id),
        plans,
        signalPayments: this.offchain.signalPayments(mandate.id),
        signalBudget: this.offchain.signalBudget(mandate.id),
      },
      mcpPublicUrl: this.config.mcpPublicUrl,
      wake: this.wakeStatus(mandate),
    };
    this.snapshotCache.set(mandate.id, snapshot);
    return snapshot;
  }

  /**
   * Any stored plan by id, not only the latest per asset: an intent's evidence chain names the plan it
   * carried out, which a newer plan may have replaced on the hedge page. Null when none is stored or it
   * cannot be read as a plan.
   */
  planView(mandate: MandateScope, planId: string): AgentPlanView | null {
    const stored = this.offchain.plan(mandate.id, planId);
    return stored ? toPlanView(stored) : null;
  }

  /** The pairing an agent announced from this address, as the console shows it, or null. */
  pairingView(mandate: MandateScope, agentAddress: string): PairingView | null {
    const pairing = this.offchain.pairing(mandate.id, agentAddress);
    return pairing ? this.toPairingView(pairing, this.follows(mandate)) : null;
  }

  private toPairingView(pairing: StoredPairing, follows: boolean): PairingView {
    return {
      agentAddress: pairing.agentAddress,
      agentName: pairing.agentName,
      serverVersion: pairing.serverVersion,
      status: pairing.status,
      announcedAt: pairing.announcedAt,
      confirmedAt: pairing.confirmedAt,
      isContractAgent: follows && this.roles ? isAddressEqual(this.roles.agent, pairing.agentAddress) : false,
    };
  }

  private chainView(mandate: MandateScope, head: { blockNumber: number; timestamp: number }): ChainView {
    const view = buildChainView(this.state, head, this.details);
    const intents = this.withListings(view.intents);
    return {
      ...view,
      intents,
      sealed: this.sealedReasons(mandate, intents),
      settlements: this.settlementViews(mandate),
      venueOrders: this.venueOrderViews(mandate),
      venue: this.venueView(mandate),
    };
  }

  /** After the executor stored a venue order version or announced its venue: pushes the new state. */
  venueChanged(): void {
    this.changed();
  }

  /**
   * The latest verified version of each venue order of the deployment `mandate` follows: none for a
   * mandate without a contract, like settlements.
   */
  private venueOrderViews(mandate: MandateScope): Record<number, VenueOrderView> {
    const session = this.follows(mandate) ? this.session : null;
    const views: Record<number, VenueOrderView> = {};
    if (!session) return views;
    for (const row of this.venueOrders.orders(session.id)) {
      const view = checkVenueOrder(row);
      if (view) views[row.intentId] = view;
    }
    return views;
  }

  /**
   * The venue the executor last announced for the deployment `mandate` follows, when it still verifies:
   * none for a mandate without a contract.
   */
  private venueView(mandate: MandateScope): ExecutorVenueView | null {
    const session = this.follows(mandate) ? this.session : null;
    const row = session ? this.venueOrders.venue(session.id) : null;
    return row ? checkExecutorVenue(row) : null;
  }

  /**
   * Each stored settlement of the live deployment, checked the way decision contexts are: the document
   * must still hash to the hash it was stored under. Its signature was checked when it was stored.
   */
  private settlementViews(mandate: MandateScope): Record<number, SettlementView> {
    const session = this.follows(mandate) ? this.session : null;
    const views: Record<number, SettlementView> = {};
    if (!session) return views;
    for (const row of this.settlements.list(session.id)) views[row.intentId] = checkSettlement(row);
    return views;
  }

  /**
   * The verified settlements of the deployment `mandate` follows, newest first, as the agent API serves
   * them: none for a mandate without a contract.
   */
  verifiedSettlements(mandate: MandateScope): StoredSettlement[] {
    const session = this.follows(mandate) ? this.session : null;
    if (!session) return [];
    return this.settlements.list(session.id).flatMap((row) => {
      const view = checkSettlement(row);
      return view.status === "verified"
        ? [
            {
              intentId: row.intentId,
              hash: view.hash,
              document: view.document,
              signature: view.signature,
              signer: view.signer,
              storedAt: view.storedAt,
            },
          ]
        : [];
    });
  }

  /**
   * After a settlement on `eventTicker` was stored for the first time: pushes the new state and offers
   * the ladder's wake-up, which goes out once every filled buy on that ladder is settled.
   */
  settlementStored(eventTicker: string): void {
    this.changed();
    // The settlement is of the server's contract: the mandate that follows it is the wake-up mandate.
    const mandate = this.accounts.store.envMandate();
    const deploymentId = this.deploymentIdFor(mandate);
    const intents = this.snapshot(mandate).chain?.intents;
    if (!deploymentId || !intents) return;
    const prefix = `GEMI-${eventTicker}-`;
    const filledBuys = intents
      .filter(
        (intent) =>
          intent.status === "executed" &&
          intent.isBuy === true &&
          (intent.filledCents ?? 0) > 0 &&
          intent.market?.startsWith(prefix) === true,
      )
      .map((intent) => intent.id);
    this.wake.onSettlement({
      deploymentId,
      eventTicker,
      filledBuys,
      settlements: this.verifiedSettlements(mandate).map((settlement) => settlement.document),
    });
  }

  /** The chain id and address of the live deployment, or null while there is none. */
  get deployment(): { chainId: number; address: Address } | null {
    const session = this.session;
    return session ? { chainId: session.deployment.chain.id, address: session.deployment.address } : null;
  }

  /**
   * Each intent with Gemini's listing of its market, as stored. Never waits on Gemini: the markets not
   * checked yet become the checker's queue, those waiting for the owner's approval first and then the
   * newest, and the snapshot is pushed again as each verdict is stored.
   */
  private withListings(intents: IntentView[]): IntentView[] {
    if (!this.listings) return intents;
    const known = this.listings.listings(listingOrder(intents));
    return intents.map((intent) => {
      const listing = intent.market === null ? undefined : known.get(intent.market);
      return listing ? { ...intent, listing } : intent;
    });
  }

  /**
   * Resolves each intent's sealed reason: the `contextHash` its `IntentProposed` event carried when the
   * contract records one, otherwise the agent's offchain link (PUT intents/:id/context) when its
   * transaction is the intent's proposal. Either way the stored document is checked with `verifyContext`.
   */
  private sealedReasons(mandate: MandateScope, intents: readonly IntentView[]): Record<number, SealedReason> {
    const session = this.session;
    const links = session
      ? this.offchain.intentContextLinks(mandate.id, session.id)
      : new Map<number, StoredIntentContextLink>();
    const claims: { id: number; hash: Hex; source: SealedSource }[] = [];
    for (const intent of intents) {
      if (intent.contextHash !== null && intent.contextHash.toLowerCase() !== ZERO_HASH) {
        claims.push({ id: intent.id, hash: intent.contextHash, source: "onchain" });
        continue;
      }
      const link = links.get(intent.id);
      if (link && link.txHash.toLowerCase() === intent.proposedTxHash.toLowerCase()) {
        claims.push({ id: intent.id, hash: link.hash, source: "offchain" });
      }
    }
    const stored = this.offchain.contexts(
      mandate.id,
      claims.map((claim) => claim.hash),
    );
    const sealed: Record<number, SealedReason> = {};
    for (const { id, hash, source } of claims) {
      const context = stored.get(hash.toLowerCase());
      if (!context) {
        sealed[id] = { status: "not_stored", source, hash };
        continue;
      }
      const document = decisionContextSchema.safeParse(context.document);
      sealed[id] =
        document.success && verifyContext(document.data, hash)
          ? { status: "verified", source, hash, document: document.data, storedAt: context.storedAt }
          : {
              status: "tampered",
              source,
              hash,
              storedAt: context.storedAt,
              claims: readClaims(context.document),
            };
    }
    return sealed;
  }

  // ---------------------------------------------------------------- the chain, per mandate

  /**
   * The contract this mandate follows, while the service is reading it: its deployment id (for records
   * that belong to one deployment), read-only client, roles and chain. Null for a mandate with no
   * contract, and while the chain is unreachable.
   */
  async chainFor(
    mandate: MandateScope,
  ): Promise<{ deploymentId: string; policy: PolicyClient; roles: Roles; chainId: number } | null> {
    if (!this.follows(mandate)) return null;
    const session = this.session;
    const roles = await this.currentRoles();
    if (!session || !roles || this.session !== session) return null;
    return { deploymentId: session.id, policy: session.policy, roles, chainId: session.deployment.chain.id };
  }

  /** The deployment id of the contract this mandate follows, without reading the chain; null when none. */
  deploymentIdFor(mandate: MandateScope): string | null {
    return this.follows(mandate) ? (this.session?.id ?? null) : null;
  }
}

// ------------------------------------------------------------------ helpers

/** A stored plan as the console shows it, or null when it cannot be read as a `HedgePlan`. */
function toPlanView(stored: StoredPlan): AgentPlanView | null {
  const plan = readHedgePlan(stored.plan);
  return plan
    ? {
        planId: stored.planId,
        asset: stored.asset,
        requestText: stored.requestText,
        createdAt: stored.createdAt,
        storedAt: stored.storedAt,
        plan,
      }
    : null;
}

/** A stored settlement, verified when its document still hashes to the hash it was stored under. */
function checkSettlement(row: SettlementRow): SettlementView {
  const document = settlementSchema.safeParse(row.document);
  return document.success && hashSettlement(document.data).toLowerCase() === row.hash.toLowerCase()
    ? {
        status: "verified",
        hash: row.hash,
        signer: row.signer,
        signature: row.signature,
        storedAt: row.storedAt,
        document: document.data,
      }
    : { status: "tampered", hash: row.hash, storedAt: row.storedAt };
}

/** A stored venue order version, when its document still hashes to the hash it was stored under. */
function checkVenueOrder(row: VenueOrderRow): VenueOrderView | null {
  const parsed = venueOrderRecordSchema.safeParse(row.document);
  if (!parsed.success || hashExecutorRecord(parsed.data).toLowerCase() !== row.hash.toLowerCase())
    return null;
  const doc = parsed.data;
  return {
    venue: doc.venue,
    environment: doc.environment,
    state: doc.state,
    venueOrderId: doc.venueOrderId,
    clientOrderId: doc.clientOrderId,
    quantityHundredths: doc.quantityHundredths,
    filledHundredths: doc.filledHundredths,
    filledCents: doc.filledCents,
    detail: doc.detail,
    updatedAt: doc.updatedAt,
  };
}

/** The stored announcement of the executor's venue, when it still hashes to what was stored. */
function checkExecutorVenue(row: SignedRow): ExecutorVenueView | null {
  const parsed = executorVenueSchema.safeParse(row.document);
  if (!parsed.success || hashExecutorRecord(parsed.data).toLowerCase() !== row.hash.toLowerCase())
    return null;
  return {
    venue: parsed.data.venue,
    environment: parsed.data.environment,
    announcedAt: parsed.data.announcedAt,
  };
}

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
