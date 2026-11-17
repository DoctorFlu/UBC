import "server-only";

import { type ListingLookup, ListingChecker, listingOrder } from "@mandate/gemini";
import {
  type IntentView,
  type PolicyEvent,
  type Roles,
  ZERO_HASH,
  decisionContextSchema,
  executorVenueSchema,
  hashExecutorRecord,
  hashSettlement,
  settlementSchema,
  type StoredSettlement,
  venueOrderRecordSchema,
  verifyContext,
} from "@mandate/shared";
import type { EnvVars } from "@mandate/shared/node";
import type { StreamBatch } from "@mandate/streams";
import type { WakeFetch, PolicyClient } from "@mandate/shared";
import { type Address, type Hex, isAddressEqual } from "viem";

import type {
  ChainView,
  ConsoleSnapshot,
  ConsoleWakeStatus,
  ContractInfo,
  ExecutorVenueView,
  FeedHealth,
  PairingView,
  SealedReason,
  SealedSource,
  SettlementView,
  VenueOrderView,
} from "@/lib/live/types";
import { readClaims } from "@/lib/evidence/claims";
import { readHedgePlan } from "@/lib/hedge/plan-schema";
import type { AgentPlanView } from "@/lib/hedge/types";
import { buildChainView } from "@/lib/live/chain-view";
import { OWNER_REQUEST_MAX_AGE_MS } from "@/lib/owner-request";

import { Accounts } from "./accounts/accounts";
import { StepUp } from "./accounts/step-up";
import { MandateManager } from "./mandates/manager";
import type { Mandate } from "./accounts/store";
import type { ConsoleConfig } from "./config";
import type { Database } from "./db";
import { ContractFollower, type FollowTarget, type Logger, type Session } from "./follower";
import { resolveDeployment } from "./ingest/deployment";
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

export type { Logger } from "./follower";

/** What the service needs to know about a mandate: whose records, and which contract it follows. */
export type MandateScope = Pick<Mandate, "id" | "deployment">;

const consoleLogger: Logger = {
  info: (message) => console.info(`[console] ${message}`),
  warn: (message) => console.warn(`[console] ${message}`),
};

/** The contract a mandate follows, while the console reads it. */
export interface MandateChain {
  /** For records that belong to one deployment: settlements, venue orders, context links. */
  deploymentId: string;
  policy: PolicyClient;
  roles: Roles;
  chainId: number;
}

/**
 * The console backend: from Policy contract logs to the state every view renders, for every mandate.
 *
 * Each contract is read by its own `ContractFollower` (RPC backfill and polling, or the QuickNode Stream):
 * the server's configured contract, which the first workspace's first mandate follows (`deployment =
 * 'env'`), and each mandate's own contract (#95), deployed by the console on the demo chain or by the
 * owner's wallet on Arc. A mandate sees only its own contract's events, settlements and venue orders, and
 * only its own offchain records; a mandate without a contract sees none.
 *
 * It survives restarts: the event cache and each contract's scan cursor are in SQLite, so a restart
 * rebuilds the same state and reads only the blocks it missed. A devchain restarted at the same address is
 * detected by the deploy block's hash and starts from scratch.
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
  /**
   * Event wake-ups of the Grok Bot routine (issue #40): the one webhook in the settings, for the mandate
   * that follows the server's contract only. Every other mandate sends none (per-agent wake-ups: #112).
   */
  readonly wake: ConsoleWake;
  /** Creating mandates, deploying their contracts, and the owner calls the console signs (#95). */
  readonly mandates: MandateManager;
  /** Passkey confirmation of each owner action the console signs (#95). */
  readonly stepUp: StepUp;
  /** The wake-ups' clock when `GROK_WAKE_TEST_CLOCK=on`, which the end-to-end tests move; otherwise null. */
  readonly wakeClock: TestClock | null;

  /** The server's configured contract. */
  private readonly envFollower: ContractFollower;
  private readonly envMandateId: string;
  /** Each mandate's own contract, by mandate id. */
  private readonly own = new Map<string, ContractFollower>();

  /** Each mandate's latest snapshot, until its next change. */
  private readonly snapshotCache = new Map<string, ConsoleSnapshot>();
  /** Each mandate's snapshot counter: its own, so one mandate's pace says nothing of another's. */
  private readonly seqs = new Map<string, number>();
  /** The live streams, by mandate: each one hears only its own mandate's snapshots. */
  private readonly listeners = new Map<
    string,
    { mandate: MandateScope; listeners: Set<(snapshot: ConsoleSnapshot) => void> }
  >();
  /** Mandates whose listeners are owed a snapshot; `all` after a change every mandate sees. */
  private pending: { all: boolean; mandates: Set<string> } = { all: false, mandates: new Set() };
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

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
    this.mandates = new MandateManager(this);
    this.stepUp = new StepUp(config.accounts, this.accounts.store);
    this.envMandateId = this.accounts.store.envMandate().id;
    this.wakeClock = config.wake.testClock ? new TestClock() : null;
    // One webhook, from the settings, for the mandate on the server's contract (docs/accounts.md).
    this.wake = new ConsoleWake(config, db, this.envMandateId, {
      logger: this.log,
      onChange: () => {
        this.changed(this.envMandateId);
      },
      ...(this.wakeClock ? { now: this.wakeClock.now, schedule: this.wakeClock.schedule } : {}),
      ...(options.ladder ? { ladder: options.ladder } : {}),
      ...(options.wakeFetch ? { fetch: options.wakeFetch } : {}),
    });
    this.envFollower = new ContractFollower(config, this.events, () => this.env, this.log, {
      resolve: () => resolveDeployment(this.env),
      onEvents: (added, all, deploymentId, history) => {
        this.wake.onChainEvents(added, all, { deploymentId, history });
      },
      // Price wake-ups ride on this loop: a check runs when the last is old enough, never more often.
      onSynced: () => {
        this.wake.tick(() => this.priceInputs());
      },
      changed: (options) => {
        this.changed(this.envMandateId, options);
      },
    });
  }

  private get env(): EnvVars {
    return this.options.env ?? process.env;
  }

  get log(): Logger {
    return this.options.logger ?? consoleLogger;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts reading every contract in the background. Calling it again does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.wake.start();
    this.envFollower.start();
    this.refreshFollowers();
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all([
      this.envFollower.stop(),
      ...[...this.own.values()].map((follower) => follower.stop()),
    ]);
    this.own.clear();
    this.listings?.stop();
    this.wake.stop();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }

  /** Resolves once the server's contract has been read up to the head at least once, or the timeout passes. */
  whenSynced(timeoutMs = 30_000): Promise<boolean> {
    return this.envFollower.whenSynced(timeoutMs);
  }

  /** Like `whenSynced`, for a mandate's own contract. False when the mandate follows none. */
  async whenMandateSynced(mandate: MandateScope, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const follower = this.followerOf(mandate);
      if (follower) return follower.whenSynced(Math.max(0, deadline - Date.now()));
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Starts a follower for every mandate that has a contract of its own and none yet, and stops those
   * whose mandate no longer has one. Called at start and whenever a mandate gets its contract.
   */
  refreshFollowers(): void {
    if (!this.running) return;
    const wanted = new Map(this.accounts.store.contractMandates().map((mandate) => [mandate.id, mandate]));
    for (const [id, follower] of this.own) {
      if (!wanted.has(id)) {
        this.own.delete(id);
        void follower.stop();
      }
    }
    for (const mandate of wanted.values()) {
      if (this.own.has(mandate.id)) continue;
      const follower = new ContractFollower(
        this.config,
        this.events,
        () => this.env,
        this.mandateLog(mandate),
        {
          resolve: () => this.resolveOwn(mandate.id),
          changed: (options) => {
            this.changed(mandate.id, options);
          },
        },
      );
      this.own.set(mandate.id, follower);
      follower.start();
    }
  }

  private mandateLog(mandate: Mandate): Logger {
    return {
      info: (message) => this.log.info(`mandate ${mandate.id}: ${message}`),
      warn: (message) => this.log.warn(`mandate ${mandate.id}: ${message}`),
    };
  }

  /**
   * Where a mandate's own contract is: on the network the server's contract is on (one RPC serves every
   * contract), at the address and deploy block stored when it was deployed.
   */
  private resolveOwn(mandateId: string): FollowTarget {
    const base = resolveDeployment(this.env);
    if (!base.ok) return base;
    const contract = this.accounts.store.mandate(mandateId)?.contract ?? null;
    if (!contract) {
      return {
        ok: false,
        network: base.network,
        detail: "This mandate has no Policy contract yet.",
        fileStamp: null,
      };
    }
    if (contract.chainId !== base.deployment.chain.id) {
      return {
        ok: false,
        network: base.network,
        fileStamp: base.fileStamp,
        detail: `This mandate's contract is on chain ${String(contract.chainId)}, but the console reads ${base.network.name}.`,
      };
    }
    return {
      ok: true,
      deployment: {
        ...base.deployment,
        address: contract.address,
        fromBlock: BigInt(contract.deployBlock),
        local: null,
      },
      network: base.network,
      kind: contract.kind,
      fileStamp: base.fileStamp,
    };
  }

  /**
   * The follower whose contract this mandate follows, or null when it follows none. By id only: a scope
   * taken before the mandate got its contract (an open stream) finds the contract all the same.
   */
  private followerOf(mandate: Pick<Mandate, "id">): ContractFollower | null {
    if (mandate.id === this.envMandateId) return this.envFollower;
    return this.own.get(mandate.id) ?? null;
  }

  /** The follower of the server's own contract: the network every mandate's contract is on. */
  get serverContract(): Session | null {
    return this.envFollower.current;
  }

  /** Roles of the server's own contract (its executor serves every mandate), read now when none yet. */
  serverRoles(): Promise<Roles | null> {
    return this.envFollower.currentRoles();
  }

  // ---------------------------------------------------------------- the pipeline

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

  /** What a price check reads: the wake-up mandate's latest plans and holdings, and its intents. */
  private priceInputs() {
    const mandateId = this.wake.mandateId;
    const plans = this.offchain.latestPlans(mandateId).flatMap((stored) => {
      const view = toPlanView(stored);
      return view ? [view] : [];
    });
    const follower = this.envFollower;
    const head = follower.head;
    const intents = head ? buildChainView(follower.state, head, follower.details).intents : [];
    return { plans, holdings: this.offchain.holdings(mandateId).holdings, intents };
  }

  /**
   * Stores a verified Stream delivery: each followed contract takes its own logs; logs of any other
   * contract and removed logs are ignored. Null while no contract is read.
   */
  async ingestStreamBatch(batch: StreamBatch): Promise<{ received: number; stored: number } | null> {
    const results = await Promise.all(
      [this.envFollower, ...this.own.values()].map((follower) => follower.ingestStreamBatch(batch)),
    );
    const read = results.filter((result) => result !== null);
    if (read.length === 0) return null;
    return {
      received: read.reduce((sum, result) => sum + result.received, 0),
      stored: read.reduce((sum, result) => sum + result.stored, 0),
    };
  }

  /** Test seam: decoded events into a mandate's contract (the server's, by default). */
  ingestEvents(events: readonly PolicyEvent[], source: IngestSource, mandate?: MandateScope): number {
    const follower = mandate ? this.followerOf(mandate) : this.envFollower;
    return follower ? follower.ingestEvents(events, source) : 0;
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

  /** Whether `owner` signed `message`, checked on the chain of the contract `mandate` follows. */
  async verifyOwnerSignature(
    mandate: MandateScope,
    owner: Address,
    message: string,
    signature: Hex,
  ): Promise<boolean> {
    return (await this.followerOf(mandate)?.verifyOwnerSignature(owner, message, signature)) ?? false;
  }

  // ---------------------------------------------------------------- snapshots

  /**
   * Marks a mandate's state changed (every mandate's without one: a change all of them see, such as a
   * Gemini listing) and tells its listeners soon after; bursts of changes become one message. `quiet`:
   * only the feed's sync time moved, so the next reader gets a fresh snapshot but nobody is pushed one.
   */
  changed(mandateId?: string, options?: { quiet: boolean }): void {
    if (mandateId === undefined) this.snapshotCache.clear();
    else this.snapshotCache.delete(mandateId);
    if (options?.quiet) return;
    if (mandateId === undefined) this.pending.all = true;
    else this.pending.mandates.add(mandateId);
    if (this.notifyTimer) return;
    if (this.listeners.size === 0) {
      this.pending = { all: false, mandates: new Set() };
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const { all, mandates } = this.pending;
      this.pending = { all: false, mandates: new Set() };
      for (const [id, { mandate, listeners }] of this.listeners) {
        if (!all && !mandates.has(id)) continue;
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

  /** The server's chain feed's health, for the public health check: says nothing about any mandate. */
  get feedHealth(): FeedHealth {
    return this.envFollower.feed.health;
  }

  /** One mandate's state, as every view renders it. */
  snapshot(mandate: MandateScope): ConsoleSnapshot {
    const cached = this.snapshotCache.get(mandate.id);
    if (cached) return cached;
    const seq = (this.seqs.get(mandate.id) ?? 0) + 1;
    this.seqs.set(mandate.id, seq);
    const follower = this.followerOf(mandate);
    const session = follower?.current ?? null;
    const lastEvent = follower?.state.events.at(-1);
    const contract: ContractInfo | null =
      follower && session
        ? {
            address: session.deployment.address,
            deployBlock: Number(session.deployBlock),
            kind: session.kind,
            roles: follower.roles,
            recordsContextHash: follower.recordsContextHash,
            // On a `server` contract the console holds the owner key and signs after a passkey says so.
            ownerSigner:
              this.accounts.store.mandate(mandate.id)?.deployment === "server" ? "console" : "wallet",
          }
        : null;
    const pairing = this.offchain.latestPairing(mandate.id);
    const holdings = this.offchain.holdings(mandate.id);
    const plans = this.offchain.latestPlans(mandate.id).flatMap((stored) => {
      const view = toPlanView(stored);
      return view ? [view] : [];
    });
    const snapshot: ConsoleSnapshot = {
      seq,
      // Without its own contract yet, the network the console runs on: the one a wallet deploys it to.
      network: follower ? follower.network : this.envFollower.network,
      feed: follower
        ? {
            ...follower.feed,
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
      chain: follower && session && follower.head ? this.chainView(mandate, follower, session) : null,
      offchain: {
        holdings: holdings.holdings,
        holdingsUpdatedAt: holdings.updatedAt,
        pairing: pairing ? this.toPairingView(pairing, follower) : null,
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
    return pairing ? this.toPairingView(pairing, this.followerOf(mandate)) : null;
  }

  private toPairingView(pairing: StoredPairing, follower: ContractFollower | null): PairingView {
    return {
      agentAddress: pairing.agentAddress,
      agentName: pairing.agentName,
      serverVersion: pairing.serverVersion,
      status: pairing.status,
      announcedAt: pairing.announcedAt,
      confirmedAt: pairing.confirmedAt,
      isContractAgent: follower?.roles ? isAddressEqual(follower.roles.agent, pairing.agentAddress) : false,
    };
  }

  private chainView(mandate: MandateScope, follower: ContractFollower, session: Session): ChainView {
    const head = follower.head ?? { blockNumber: 0, timestamp: 0 };
    const view = buildChainView(follower.state, head, follower.details);
    const intents = this.withListings(view.intents);
    return {
      ...view,
      intents,
      sealed: this.sealedReasons(mandate, session.id, intents),
      settlements: this.settlementViews(session.id),
      venueOrders: this.venueOrderViews(session.id),
      venue: this.venueView(session.id),
    };
  }

  /** After the executor stored a venue order version or announced its venue for `mandate`'s contract. */
  venueChanged(mandate: MandateScope): void {
    this.changed(mandate.id);
  }

  /** The latest verified version of each venue order of one deployment. */
  private venueOrderViews(deploymentId: string): Record<number, VenueOrderView> {
    const views: Record<number, VenueOrderView> = {};
    for (const row of this.venueOrders.orders(deploymentId)) {
      const view = checkVenueOrder(row);
      if (view) views[row.intentId] = view;
    }
    return views;
  }

  /** The venue the executor last announced for one deployment, when it still verifies. */
  private venueView(deploymentId: string): ExecutorVenueView | null {
    const row = this.venueOrders.venue(deploymentId);
    return row ? checkExecutorVenue(row) : null;
  }

  /**
   * Each stored settlement of one deployment, checked the way decision contexts are: the document must
   * still hash to the hash it was stored under. Its signature was checked when it was stored.
   */
  private settlementViews(deploymentId: string): Record<number, SettlementView> {
    const views: Record<number, SettlementView> = {};
    for (const row of this.settlements.list(deploymentId)) views[row.intentId] = checkSettlement(row);
    return views;
  }

  /**
   * The verified settlements of the contract `mandate` follows, newest first, as the agent API serves
   * them: none for a mandate without a contract.
   */
  verifiedSettlements(mandate: MandateScope): StoredSettlement[] {
    const deploymentId = this.deploymentIdFor(mandate);
    if (!deploymentId) return [];
    return this.settlements.list(deploymentId).flatMap((row) => {
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
   * After a settlement of `mandate`'s contract on `eventTicker` was stored for the first time: pushes the
   * new state and, for the mandate the wake-ups serve, offers the ladder's wake-up, which goes out once
   * every filled buy on that ladder is settled.
   */
  settlementStored(mandate: MandateScope, eventTicker: string): void {
    this.changed(mandate.id);
    if (mandate.id !== this.wake.mandateId) return;
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
  private sealedReasons(
    mandate: MandateScope,
    deploymentId: string,
    intents: readonly IntentView[],
  ): Record<number, SealedReason> {
    const links: Map<number, StoredIntentContextLink> = this.offchain.intentContextLinks(
      mandate.id,
      deploymentId,
    );
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
   * The contract this mandate follows, while the console is reading it: its deployment id (for records
   * that belong to one deployment), read-only client, roles and chain. Null for a mandate with no
   * contract, and while the chain is unreachable.
   */
  async chainFor(mandate: MandateScope): Promise<MandateChain | null> {
    const follower = this.followerOf(mandate);
    if (!follower) return null;
    const session = follower.current;
    const roles = await follower.currentRoles();
    if (!session || !roles || follower.current !== session) return null;
    return { deploymentId: session.id, policy: session.policy, roles, chainId: session.deployment.chain.id };
  }

  /** The deployment id of the contract this mandate follows, without reading the chain; null when none. */
  deploymentIdFor(mandate: MandateScope): string | null {
    return this.followerOf(mandate)?.current?.id ?? null;
  }

  /**
   * The mandate whose contract is `address` on `chainId`, with that contract as the console reads it: how
   * the executor's records find their mandate. Null for a contract no mandate follows, or one the console
   * is not reading right now.
   */
  async contractOf(
    chainId: number,
    address: Address,
  ): Promise<{ mandate: Mandate; chain: MandateChain } | null> {
    const env = this.envFollower.current;
    const mandate =
      env && env.deployment.chain.id === chainId && isAddressEqual(env.deployment.address, address)
        ? this.accounts.store.mandate(this.envMandateId)
        : this.accounts.store.mandateByContract(chainId, address);
    if (!mandate) return null;
    const chain = await this.chainFor(mandate);
    if (!chain || chain.chainId !== chainId || !isAddressEqual(chain.policy.address, address)) return null;
    return { mandate, chain };
  }

  /** Every contract the console follows, as the executor's discovery lists them. */
  followedContracts(): {
    mandate: Mandate;
    chainId: number;
    address: Address;
    deployBlock: number;
    executor: Address | null;
  }[] {
    const list: {
      mandate: Mandate;
      chainId: number;
      address: Address;
      deployBlock: number;
      executor: Address | null;
    }[] = [];
    const env = this.envFollower.current;
    const envMandate = this.accounts.store.mandate(this.envMandateId);
    if (env && envMandate) {
      list.push({
        mandate: envMandate,
        chainId: env.deployment.chain.id,
        address: env.deployment.address,
        deployBlock: Number(env.deployBlock),
        executor: this.envFollower.roles?.executor ?? null,
      });
    }
    for (const mandate of this.accounts.store.contractMandates()) {
      const follower = this.own.get(mandate.id);
      const session = follower?.current;
      if (!follower || !session) continue;
      list.push({
        mandate,
        chainId: session.deployment.chain.id,
        address: session.deployment.address,
        deployBlock: Number(session.deployBlock),
        executor: follower.roles?.executor ?? null,
      });
    }
    return list;
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
