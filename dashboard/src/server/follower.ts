import "server-only";

import {
  type Intent,
  type PolicyEvent,
  type PolicyViewState,
  type Roles,
  PolicyClient,
  applyEvents,
  decodePolicyLogs,
  emptyPolicyViewState,
  intentsMissingDetails,
  reduceEvents,
  toSafeNumber,
} from "@mandate/shared";
import type { EnvVars, ResolvedDeployment } from "@mandate/shared/node";
import type { StreamBatch } from "@mandate/streams";
import { type Address, type Hex, type Log, createPublicClient, http, isAddressEqual } from "viem";

import type { ConsoleNetwork, ContractKind, FeedHealth, FeedStatus } from "@/lib/live/types";

import type { ConsoleConfig } from "./config";
import { type ChainClient, LogScanner, blockTimestamps, findDeployBlock } from "./ingest/chain-reader";
import { UNCONFIGURED_NETWORK, deploymentFileStamp } from "./ingest/deployment";
import type { EventStore, IngestSource } from "./store/events";

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/** One connection to one deployed Policy contract. A new deployment (or a reset devchain) is a new session. */
export interface Session {
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

/** Where a follower's contract is, read again before every session: it can move (a restarted devchain). */
export type FollowTarget =
  | {
      ok: true;
      deployment: ResolvedDeployment;
      network: ConsoleNetwork;
      kind: ContractKind | null;
      fileStamp: number | null;
    }
  | { ok: false; network: ConsoleNetwork; detail: string; fileStamp: number | null };

export interface FollowerHooks {
  /** Where the contract is now. */
  resolve: () => FollowTarget | Promise<FollowTarget>;
  /** Newly stored events, after the state took them; `history` while backfilling a new deployment. */
  onEvents?: (
    added: readonly PolicyEvent[],
    all: readonly PolicyEvent[],
    deploymentId: string,
    history: boolean,
  ) => void;
  /** After each poll that read the chain up to its head. */
  onSynced?: () => void;
  /**
   * The state changed in a way this contract's views show. `quiet`: only the feed's sync time moved, so
   * the next reader gets it but nobody is pushed a snapshot for it.
   */
  changed: (options?: { quiet: boolean }) => void;
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
 * Follows one Policy contract: backfills its events from the deploy block, then polls (or takes the
 * QuickNode Stream), and folds every stored event into the shared reducer's state. The console runs one
 * per contract it follows: the server's own, and each mandate's own contract (#95). A follower knows
 * nothing of mandates; the console decides whose views read it.
 */
export class ContractFollower {
  private session: Session | null = null;
  network: ConsoleNetwork = UNCONFIGURED_NETWORK;
  state: PolicyViewState = emptyPolicyViewState();
  details = new Map<number, Intent>();
  head: { blockNumber: number; timestamp: number } | null = null;
  roles: Roles | null = null;
  recordsContextHash: boolean | null = null;
  private rolesReadAt = 0;
  feed: FeedStatus;
  private lastStreamAt = 0;
  private lastPushAt = 0;

  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly config: ConsoleConfig,
    private readonly events: EventStore,
    private readonly env: () => EnvVars,
    private readonly log: Logger,
    private readonly hooks: FollowerHooks,
  ) {
    this.feed = {
      source: config.eventSource,
      health: "starting",
      detail: "Connecting to the chain.",
      lastEventAt: null,
      lastSyncAt: null,
      syncedBlock: null,
    };
  }

  // ---------------------------------------------------------------- lifecycle

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
  }

  /** Resolves once the follower has read the chain up to its head at least once, or the timeout passes. */
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
        const target = await this.hooks.resolve();
        if (!target.ok) {
          this.closeSession();
          this.network = target.network;
          this.setFeed({ health: "unconfigured", detail: target.detail, syncedBlock: null });
          await sleep(1_000, signal);
          continue;
        }
        this.network = target.network;
        const session = await this.openSession(target.deployment, target.kind, target.fileStamp);
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
      // One HTTP request for reads issued together; retries are this follower's job, with backoff.
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
        this.hooks.changed();
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
    this.hooks.changed();
  }

  /** Backfills, then polls until the deployment changes or a read fails. */
  private async follow(session: Session, signal: AbortSignal): Promise<void> {
    const primaryRpc = this.config.eventSource === "rpc";
    const interval = this.pollIntervalMs(session);
    while (!signal.aborted && this.session === session) {
      if (session.deployment.source === "devchain" && deploymentFileStamp(this.env()) !== session.fileStamp) {
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
      this.hooks.onSynced?.();
      await sleep(primaryRpc ? interval : Math.max(interval, STREAM_SAFETY_POLL_MS), signal);
    }
  }

  private pollIntervalMs(session: Session | null): number {
    if (this.config.pollIntervalMs > 0) return this.config.pollIntervalMs;
    return session?.deployment.source === "devchain" ? 250 : 1_000;
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
    const ms = this.pollIntervalMs(this.session);
    return ms < 1_000 ? `${String(ms)} ms` : `${String(ms / 1_000)} s`;
  }

  // ---------------------------------------------------------------- the pipeline

  /**
   * Folds newly stored events into the state and offers them to the hook. Every source ends here, so a
   * trigger fires once whichever source (RPC poll or QuickNode Stream) delivered its event.
   */
  private apply(added: readonly PolicyEvent[], history = false): void {
    if (added.length === 0) return;
    this.state = applyEvents(this.state, added);
    const session = this.session;
    if (session) this.hooks.onEvents?.(added, this.state.events, session.id, history);
    this.hooks.changed();
  }

  /** Whether this follower reads the contract at `address`. */
  follows(address: Address): boolean {
    return this.session !== null && isAddressEqual(this.session.deployment.address, address);
  }

  /**
   * Stores a verified Stream delivery's logs of this contract and applies their events. Removed logs are
   * ignored. Null while no contract is read; otherwise how many logs were this contract's and how many
   * events were new.
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
      this.hooks.changed();
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
    if (read.length > 0) this.hooks.changed();
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
    if (changed) this.hooks.changed();
  }

  /** Roles as last read, reading them now when there are none yet. Null when the chain is unreachable. */
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

  /** The contract being read, or null while none is. */
  get current(): Session | null {
    return this.session;
  }

  /**
   * Updates the feed status. A poll that only confirms the follower is current (a new `lastSyncAt` or
   * `syncedBlock`, nothing else) is not news: it reaches browsers at most every `QUIET_PUSH_MS`.
   */
  private setFeed(patch: Partial<FeedStatus>): void {
    const next = { ...this.feed, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.feed)) return;
    const quiet = (feed: FeedStatus) => JSON.stringify({ ...feed, lastSyncAt: null, syncedBlock: null });
    const news = quiet(next) !== quiet(this.feed);
    this.feed = next;
    if (news || Date.now() - this.lastPushAt >= QUIET_PUSH_MS) {
      this.lastPushAt = Date.now();
      this.hooks.changed();
    } else {
      this.hooks.changed({ quiet: true });
    }
  }
}

/** Reads `signal.aborted` afresh: it can flip during any await, which control-flow narrowing ignores. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export function errorMessage(error: unknown): string {
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
