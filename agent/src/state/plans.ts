import type { HedgePlan } from "@mandate/planner";
import type { CategoryId, LadderSummary } from "@mandate/shared";

/**
 * Hedge plans kept by the server process.
 *
 * Grok Bot opens a fresh MCP session for every tool call, so `execute_plan` always arrives in a
 * different session from the `plan_hedge` that made the plan. The plan therefore lives here, keyed
 * by its id, together with the progress of its execution, which also makes `execute_plan`
 * idempotent: calling it again continues or reports, and never submits an order twice.
 */

/** How long a plan can be executed after it was made. Prices move; an older plan must be redone. */
export const PLAN_EXECUTABLE_FOR_MS = 30 * 60_000;
/** How long a plan and its execution record stay readable. */
export const PLAN_RETAINED_FOR_MS = 6 * 60 * 60_000;
export const MAX_PLANS = 100;

/** The lock key for reading and adding positions on one ladder. */
export function ladderLockKey(eventTicker: string): string {
  return `ladder:${eventTicker}`;
}

/** What happened to one order of a plan. */
export interface OrderOutcome {
  orderIndex: number;
  rungIndex: number;
  instrumentSymbol: string;
  amountCents: number;
  limitPrice: number;
  /** The contract's answer, or `error` when the proposal could not be submitted. */
  decision: "approved" | "needs_approval" | "rejected" | "error";
  intentId: number | null;
  /** The contract's rejection reason, or the error code. */
  reason: string | null;
  txHash: `0x${string}` | null;
  contextHash: `0x${string}` | null;
  /** Whether the console links the intent to its context; null without a console or an intent. */
  contextLinked: boolean | null;
}

export interface StoredPlan {
  readonly plan: HedgePlan;
  readonly requestText: string;
  readonly createdAt: Date;
  /** The ladder as the planner saw it, for the decision context of each order. */
  readonly ladderSummary: LadderSummary;
  /** Mandate category of the ladder's market. */
  readonly categoryId: CategoryId;
  /** Every strike of the ladder, to read the positions held on it again at execution. */
  readonly strikes: readonly { instrumentSymbol: string; strikeCents: number }[];
  /**
   * The intents whose positions the plan counted as already held. Execution sends an order only while
   * every other position on the ladder is one of these or one of the plan's own orders, so a plan made
   * before other orders landed can never add protection a second time.
   */
  readonly basis: ReadonlySet<number>;
  /** Whether the console accepted the plan. */
  consoleStored: boolean;
  /** One entry per submitted order, in plan order. */
  readonly outcomes: OrderOutcome[];
  /** Set once an order was rejected: execution stops there for good. */
  stoppedAt: number | null;
}

export class PlanStore {
  readonly #plans = new Map<string, StoredPlan>();
  readonly #locks = new Map<string, Promise<unknown>>();

  /** Stores a plan, or returns the stored one when the same plan id was stored before. */
  put(entry: Omit<StoredPlan, "outcomes" | "stoppedAt">, now: Date): StoredPlan {
    this.#evict(now);
    const existing = this.#plans.get(entry.plan.planId);
    if (existing !== undefined) return existing;
    const stored: StoredPlan = { ...entry, outcomes: [], stoppedAt: null };
    this.#plans.set(entry.plan.planId, stored);
    return stored;
  }

  get(planId: string, now: Date): StoredPlan | undefined {
    this.#evict(now);
    return this.#plans.get(planId);
  }

  /**
   * Runs `work` for one key at a time, so two calls for the same key never interleave. Keys are plan
   * ids, or `ladderLockKey` for everything that reads and then adds positions on one ladder.
   *
   * `whileWaiting` gets the wait for the key's previous holder and returns the wait to use, for
   * example one that gives up when the caller's deadline passes. A caller that gives up never runs
   * `work`, and the callers after it wait only for the holder before it.
   */
  async exclusive<T>(
    key: string,
    work: () => Promise<T>,
    options: { whileWaiting?: (wait: Promise<unknown>) => Promise<unknown> } = {},
  ): Promise<T> {
    // Every entry is a slot that only ever resolves, so a waiter never sees a rejection.
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => mine);
    this.#locks.set(key, slot);
    void slot.then(() => {
      if (this.#locks.get(key) === slot) this.#locks.delete(key);
    });
    try {
      await (options.whileWaiting === undefined ? previous : options.whileWaiting(previous));
      return await work();
    } finally {
      release();
    }
  }

  #evict(now: Date): void {
    for (const [id, stored] of this.#plans) {
      if (now.getTime() - stored.createdAt.getTime() > PLAN_RETAINED_FOR_MS) this.#plans.delete(id);
    }
    // Maps iterate in insertion order, so the first keys are the oldest plans.
    for (const id of this.#plans.keys()) {
      if (this.#plans.size <= MAX_PLANS) break;
      this.#plans.delete(id);
    }
  }
}
