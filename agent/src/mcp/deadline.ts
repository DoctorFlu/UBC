/**
 * One deadline per tool call (issue #105).
 *
 * Grok Bot, like any MCP client, gives up on a call after a while, and a call it gave up on looks like
 * a dead server. So every call gets one time budget. When it runs out, or the client goes away
 * first, the call's signal aborts: every Gemini, chain and console request in its path is aborted,
 * nothing more is started, and the tool answers with what it has. Each upstream request runs as a
 * named step, so the answer and the log can say what was slow.
 *
 * Some work must never be cut once begun: a proposal that may have reached the chain, a payment that
 * may have been signed. Such work starts only while enough of the budget is left for it to finish
 * (`beginCommit`). Neither the deadline nor the client going away cuts it; it gets the rest of the
 * budget plus `COMMIT_GRACE_MS` to learn its outcome, and then reports it as unconfirmed. So the
 * answer comes at most `COMMIT_GRACE_MS` after the deadline, and never leaves unknown what was sent.
 */
import { raceAbort } from "@mandate/shared";

/** How long past the deadline work that cannot be cut may still wait for its outcome. */
export const COMMIT_GRACE_MS = 3_000;

/** Work that must not be cut, in progress. */
export interface Commit {
  /** The most the rest of it may take: the call's remaining time plus `COMMIT_GRACE_MS`. */
  readonly bound: AbortSignal;
  /** Marks it done. Safe to call more than once. */
  readonly end: () => void;
}

/** Which kind of upstream a step waits for. */
export type Upstream = "gemini" | "chain" | "console" | "signals" | "lock";

/**
 * Every step a tool can wait on, with its upstream and a plain description. Names are fixed labels and
 * never carry an argument (a ticker, an id), because they reach the log and the answer.
 */
export const STEPS = {
  "gemini.events": ["gemini", "the list of events"],
  "gemini.event": ["gemini", "one event"],
  "gemini.ladders": ["gemini", "the list of ladders"],
  "gemini.ladder": ["gemini", "the strike ladder and its order books"],
  "gemini.spot": ["gemini", "the spot price"],
  "gemini.market": ["gemini", "the market's listing"],
  "chain.capabilities": ["chain", "the contract's extensions"],
  "chain.snapshot": ["chain", "the mandate's rules and spend"],
  "chain.roles": ["chain", "the contract's roles"],
  "chain.balance": ["chain", "the agent's gas balance"],
  "chain.intent_count": ["chain", "the number of intents"],
  "chain.intent": ["chain", "one intent"],
  "chain.events": ["chain", "the contract's events"],
  "chain.preview": ["chain", "the trade preview"],
  "chain.propose": ["chain", "the proposal"],
  "console.holdings": ["console", "the owner's holdings"],
  "console.context": ["console", "a decision context"],
  "console.intent_context": ["console", "an intent's link to its context"],
  "console.plan": ["console", "the plan"],
  "console.change_request": ["console", "the change request"],
  "console.pairing": ["console", "the pairing"],
  "console.signal_payment": ["console", "the signal payment report"],
  "console.signal_budget": ["console", "the signal budget report"],
  "console.settlements": ["console", "the settlements"],
  "signals.buy": ["signals", "the signal purchase"],
  "lock.plan": ["lock", "plan"],
  "lock.ladder": ["lock", "ladder"],
  "lock.replay": ["lock", "trade"],
} as const satisfies Record<string, readonly [Upstream, string]>;

export type StepName = keyof typeof STEPS;

export type StopReason = "deadline" | "client_gone";

/** Why and where a call was stopped. */
export interface Stop {
  readonly reason: StopReason;
  /** The step that had been waiting longest, or null when no upstream step was running. */
  readonly step: StepName | null;
  /** How long that step had been waiting. */
  readonly stepMs: number | null;
  /** Other steps still running, longest waiting first. */
  readonly alsoWaiting: readonly StepName[];
  /** Time since the call started. */
  readonly elapsedMs: number;
}

/** The abort reason of a stopped call. Upstream code rethrows it unchanged. */
export class CallStopped extends Error {
  override readonly name = "CallStopped";
  readonly stop: Stop;

  constructor(stop: Stop) {
    super(stop.reason === "deadline" ? "The tool call ran out of time." : "The client stopped waiting.");
    this.stop = stop;
  }
}

/** Thrown when too little of the budget is left to start work that cannot be cut. Nothing was started. */
export class NotEnoughTime extends Error {
  override readonly name = "NotEnoughTime";
}

export class CallDeadline {
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  readonly #controller = new AbortController();
  readonly #startedAt = performance.now();
  readonly #steps = new Map<number, { step: StepName; startedAt: number }>();
  readonly #timer: NodeJS.Timeout;
  readonly #client: AbortSignal | undefined;
  readonly #onClientGone = () => {
    this.#halt("client_gone");
  };
  readonly #onStop: ((stop: Stop) => void) | undefined;
  #nextStep = 0;
  #commits = 0;
  #commitWaiters: (() => void)[] = [];
  #stop: Stop | undefined;

  constructor(options: {
    budgetMs: number;
    /** Aborts when the client goes away (the HTTP request's signal). */
    clientSignal?: AbortSignal | undefined;
    /** Called once, when the call is stopped, before its signal aborts. */
    onStop?: (stop: Stop) => void;
  }) {
    this.budgetMs = options.budgetMs;
    this.signal = this.#controller.signal;
    this.#onStop = options.onStop;
    this.#timer = setTimeout(() => {
      this.#halt("deadline");
    }, options.budgetMs);
    // The server keeps the process alive; a pending deadline never should.
    this.#timer.unref();
    this.#client = options.clientSignal;
    if (this.#client?.aborted) this.#halt("client_gone");
    else this.#client?.addEventListener("abort", this.#onClientGone, { once: true });
  }

  /** Why the call was stopped, or undefined while it runs. */
  get stop(): Stop | undefined {
    return this.#stop;
  }

  elapsedMs(): number {
    return performance.now() - this.#startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  /**
   * Runs one upstream step under the call's signal, recorded by name while it runs. `work` must pass
   * the signal on to every request it makes. Throws `CallStopped` without starting when the call is over.
   */
  async step<T>(step: StepName, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const id = this.#nextStep++;
    this.#steps.set(id, { step, startedAt: performance.now() });
    try {
      return await work(this.signal);
    } finally {
      this.#steps.delete(id);
    }
  }

  /** Waits for `wait` (a lock, another call's result) as a step, giving up when the call is stopped. */
  waitFor<T>(step: StepName, wait: Promise<T>): Promise<T> {
    return this.step(step, (signal) => raceAbort(wait, signal));
  }

  /**
   * Marks the start of work that must not be cut once begun. Throws, starting nothing, when the call
   * is already stopped or less than `reserveMs` of the budget is left.
   */
  beginCommit(reserveMs: number): Commit {
    this.signal.throwIfAborted();
    const remaining = this.remainingMs();
    if (remaining < reserveMs) {
      throw new NotEnoughTime(`Less than ${seconds(reserveMs)} of this call's time is left.`);
    }
    this.#commits += 1;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.#commits -= 1;
      if (this.#commits === 0) {
        for (const resolve of this.#commitWaiters.splice(0)) resolve();
      }
    };
    return { bound: AbortSignal.timeout(Math.ceil(remaining) + COMMIT_GRACE_MS), end };
  }

  /** Whether work that must not be cut is in progress. */
  committing(): boolean {
    return this.#commits > 0;
  }

  /** Resolves once no work that must not be cut is in progress. */
  commitsSettled(): Promise<void> {
    if (this.#commits === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#commitWaiters.push(resolve);
    });
  }

  /** Stops the timer and stops listening for the client. Call once the call has its answer. */
  dispose(): void {
    clearTimeout(this.#timer);
    this.#client?.removeEventListener("abort", this.#onClientGone);
  }

  #halt(reason: StopReason): void {
    if (this.#stop !== undefined) return;
    this.dispose();
    const now = performance.now();
    const running = [...this.#steps.values()].sort((a, b) => a.startedAt - b.startedAt);
    const first = running[0];
    this.#stop = {
      reason,
      step: first?.step ?? null,
      stepMs: first === undefined ? null : Math.round(now - first.startedAt),
      alsoWaiting: [...new Set(running.slice(1).map((s) => s.step))].slice(0, 5),
      elapsedMs: Math.round(now - this.#startedAt),
    };
    this.#onStop?.(this.#stop);
    this.#controller.abort(new CallStopped(this.#stop));
  }
}

const UPSTREAM_LABEL: Record<Exclude<Upstream, "lock">, string> = {
  gemini: "Gemini's public market data",
  chain: "The Arc RPC endpoint",
  console: "The console",
  signals: "The signal API",
};

/** One plain sentence saying what was slow, for the answer. Never names an argument. */
export function describeStop(stop: Stop, budgetMs: number): string {
  const limit = seconds(budgetMs);
  if (stop.reason === "client_gone") return "The client stopped waiting before this call finished.";
  if (stop.step === null) return `The server could not finish this call within its ${limit} limit.`;
  const [upstream, what] = STEPS[stop.step];
  if (upstream === "lock") {
    return `Another call on the same ${what} was still running when this call's ${limit} limit was reached.`;
  }
  return `${UPSTREAM_LABEL[upstream]} did not answer within this call's ${limit} limit (${what}).`;
}

/** "25 s", or "2.5 s" for a budget that is not a whole number of seconds. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return `${Number.isInteger(value) ? value.toString() : value.toFixed(1)} s`;
}
