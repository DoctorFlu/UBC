import "server-only";

import type { Ladder } from "@mandate/gemini";
import {
  type IntentView,
  type LadderSettlementInput,
  type PolicyEvent,
  type PriceGoal,
  type WakeFetch,
  type WakeGate,
  WakeNotifier,
  type WakeTarget,
  chainWakes,
  initialPriceMemory,
  ladderSettledWake,
  priceWakes,
} from "@mandate/shared";

import { coverNow } from "@/features/hedge/cover-now";
import type { AgentPlanView } from "@/lib/hedge/types";
import { mandatePath } from "@/lib/mandate-path";
import type { ConsoleWakeStatus } from "@/lib/live/types";

import type { ConsoleConfig } from "./config";
import type { Database } from "./db";
import { ladderQuotes } from "./market/quotes";
import { SqliteWakeStore } from "./store/wakes";

/** Gemini's ladder for a goal, through the console's rate-limited and cached client. */
export type LadderSource = (
  asset: string,
  eventTicker: string,
) => Promise<{ ok: true; ladder: Ladder } | { ok: false }>;

/** What a price check reads from the console's state. */
export interface PriceInputs {
  plans: readonly AgentPlanView[];
  holdings: readonly { asset: string; quantity: string }[];
  intents: readonly IntentView[];
}

/** Goals checked per price check: one per asset, the newest first. Each costs at most 2 Gemini requests. */
export const MAX_PRICE_GOALS = 4;

/**
 * The console side of event wake-ups (issue #40, `docs/event-wake.md`): it feeds the shared rules from
 * the console's own pipeline and sends through `WakeNotifier`, recorded in the console's SQLite file.
 *
 * - Chain events: every source (RPC poll or QuickNode Stream) ends in `ConsoleService.apply`, which hands
 *   the newly stored events here, so a trigger fires once whichever source delivered it.
 * - Price: no timer of its own. The console's poll loop calls `tick` and a check runs when the last one
 *   is older than `GROK_WAKE_PRICE_CHECK_MS`, so the first poll after a paused machine wakes checks at once.
 * - Runs in progress: every authenticated call from this mandate's agent marks one.
 * - Settlements: the executor API hands each newly stored settlement of this mandate's deployment here;
 *   a ladder wakes the Bot once, when its last filled position is settled.
 *
 * One instance serves one mandate (`mandateId`), whose records it alone reads and writes, and posts to
 * that mandate's agent's webhook only (#112): the agent's own, or for the mandate on the server's contract
 * until its agent has one, the webhook in the settings (`MandateWakes`, docs/event-wake.md). Every
 * instance keeps its own cap, debounce windows, price memory and queue.
 */
export class ConsoleWake {
  readonly notifier: WakeNotifier;
  private readonly store: SqliteWakeStore;
  private lastPriceCheckAt: number | null = null;
  private priceCheck: Promise<void> | null = null;
  private priceProblem: string | null = null;
  private offReason: string | null;
  private send: WakeFetch;

  constructor(
    private readonly config: ConsoleConfig,
    db: Database,
    readonly mandateId: string,
    private readonly options: {
      /** Where to post; null while this mandate has no webhook. Defaults to the settings' webhook. */
      target?: WakeTarget | null;
      /** Why wake-ups are off, when `target` is null. Defaults to the settings' reason. */
      offReason?: string | null;
      ladder?: LadderSource;
      logger: { info: (message: string) => void; warn: (message: string) => void };
      onChange: () => void;
      fetch?: WakeFetch;
      /** Bounds the requests in flight across every mandate's wake-ups. */
      gate?: WakeGate;
      now?: () => number;
      /** Runs a task after some time on the same clock as `now` (`test-clock.ts`). */
      schedule?: (task: () => void, ms: number) => () => void;
    },
  ) {
    const target = options.target === undefined ? config.wake.target : options.target;
    this.offReason = options.offReason === undefined ? config.wake.offReason : options.offReason;
    this.send = options.fetch ?? ((url, init) => fetch(url, init));
    this.store = new SqliteWakeStore(db, mandateId);
    this.notifier = new WakeNotifier({
      target,
      dailyCap: config.wake.dailyCap,
      store: this.store,
      // Links open this mandate's own pages (#95).
      publicUrl: `${config.publicUrl}${mandatePath(mandateId)}`,
      logger: { info: (m) => options.logger.info(m), warn: (m) => options.logger.warn(m) },
      onChange: options.onChange,
      // Through `send`, so `retarget` can change how as well as where.
      fetch: (url, init) => this.send(url, init),
      ...(options.gate ? { gate: options.gate } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.schedule ? { schedule: options.schedule } : {}),
    });
  }

  /**
   * Points this mandate's wake-ups at another webhook, sent with `send`, or turns them off (`target` null,
   * with the reason the owner sees). What was waiting for the old webhook is never sent to the new one.
   */
  retarget(target: WakeTarget | null, offReason: string | null, send: WakeFetch): void {
    this.send = send;
    this.offReason = target === null ? offReason : null;
    if (target !== null && !this.enabled) this.store.prune(this.now);
    this.notifier.setTarget(target);
    this.options.onChange();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  get enabled(): boolean {
    return this.notifier.enabled;
  }

  start(): void {
    if (this.enabled) this.store.prune(this.now);
    this.notifier.start();
  }

  stop(): void {
    this.notifier.stop();
  }

  noteAgentActivity(): void {
    this.notifier.noteAgentActivity(this.now);
  }

  /** Newly stored chain events, in chain order, with every event of the deployment (`all`). */
  onChainEvents(
    added: readonly PolicyEvent[],
    all: readonly PolicyEvent[],
    context: { deploymentId: string; history: boolean },
  ): void {
    if (!this.enabled || added.length === 0) return;
    const now = this.now;
    const { wakes } = chainWakes(added, all, {
      ...context,
      now,
      runInProgress: this.notifier.runInProgress(now),
    });
    this.notifier.offer(wakes);
  }

  /**
   * A settlement was stored for the first time (issue #92). Offers the ladder's one wake-up once every
   * filled buy on it is settled; the rule (`ladderSettledWake`) says why.
   */
  onSettlement(input: Omit<LadderSettlementInput, "now">): void {
    if (!this.enabled) return;
    const wake = ladderSettledWake({ ...input, now: this.now });
    if (wake) this.notifier.offer([wake]);
  }

  /** Starts a price check when the last one is old enough. Never waits for it. */
  tick(inputs: () => PriceInputs): void {
    if (!this.enabled || !this.options.ladder || this.priceCheck) return;
    const now = this.now;
    if (this.lastPriceCheckAt !== null && now - this.lastPriceCheckAt < this.config.wake.priceCheckMs) return;
    this.lastPriceCheckAt = now;
    this.priceCheck = this.checkPrices(inputs()).finally(() => {
      this.priceCheck = null;
    });
  }

  /** Resolves when the price check in progress, if any, is done. For tests. */
  async settled(): Promise<void> {
    await this.priceCheck;
    await this.notifier.flush();
  }

  status(): ConsoleWakeStatus {
    return {
      ...this.notifier.status(),
      offReason: this.enabled ? null : this.offReason,
      priceCheckEveryMs: this.config.wake.priceCheckMs,
      lastPriceCheckAt: this.lastPriceCheckAt === null ? null : new Date(this.lastPriceCheckAt).toISOString(),
      priceProblem: this.priceProblem,
    };
  }

  /** One check of each current goal: Gemini's spot, then the server's cover computation (`coverNow`). */
  private async checkPrices(inputs: PriceInputs): Promise<void> {
    const ladder = this.options.ladder;
    if (!ladder) return;
    const goals = currentGoals(inputs.plans, this.now);
    let problem: string | null = null;
    for (const view of goals) {
      const plan = view.plan;
      if (plan.floorCents === null) continue;
      const lookup = await ladder(plan.asset, plan.eventTicker).catch(() => ({ ok: false as const }));
      if (!lookup.ok) {
        problem = "Gemini's quotes were not available at the last check.";
        continue;
      }
      const quotes = ladderQuotes(lookup.ladder);
      const holding = inputs.holdings.find((h) => h.asset === plan.asset)?.quantity ?? null;
      const cover = coverNow({ plan, holdingQuantity: holding, quotes, intents: inputs.intents });
      const goal: PriceGoal = {
        planId: view.planId,
        asset: plan.asset,
        eventTicker: plan.eventTicker,
        floorCents: plan.floorCents,
        planSpotCents: plan.spotCents,
      };
      const memory = this.store.priceMemory(view.planId) ?? initialPriceMemory(goal);
      const now = this.now;
      const result = priceWakes(
        goal,
        memory,
        {
          spotCents: quotes.spotCents,
          cover: cover ? { state: cover.assessment.state, coverBps: cover.assessment.coverBps } : null,
        },
        now,
      );
      // Offered first: its trigger ids are deterministic, so a crash before the memory is saved
      // offers the same triggers again, which the notifier ignores.
      this.notifier.offer(result.wakes);
      this.store.savePriceMemory(view.planId, result.memory, now);
    }
    if (problem !== this.priceProblem) {
      this.priceProblem = problem;
      this.options.onChange();
    }
  }
}

/** Why a mandate whose agent has no webhook sends no wake-ups (#112). */
export const NO_WAKE_TARGET_REASON =
  "Connect this agent's Grok Bot routine under Agents in Setup to turn wake-ups on.";

/** The wake-up status of a mandate the console sends no wake-ups for: off, with nothing recorded. */
export function wakeOffStatus(config: ConsoleConfig, offReason: string): ConsoleWakeStatus {
  return {
    enabled: false,
    dailyCap: config.wake.dailyCap,
    usedToday: 0,
    leftToday: config.wake.dailyCap,
    recent: [],
    offReason,
    priceCheckEveryMs: config.wake.priceCheckMs,
    lastPriceCheckAt: null,
    priceProblem: null,
  };
}

/** The goals a price check measures: the latest plan per asset with a floor, on a ladder not yet expired. */
export function currentGoals(plans: readonly AgentPlanView[], now: number): AgentPlanView[] {
  return plans
    .filter((view) => view.plan.floorCents !== null && Date.parse(view.plan.expiry) > now)
    .slice(0, MAX_PRICE_GOALS);
}
