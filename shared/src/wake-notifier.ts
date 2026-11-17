import {
  type WakeCandidate,
  type WakeDetail,
  type WakeEvent,
  type WakeKind,
  RUN_QUIET_MS,
  WAKE_DEBOUNCE_MS,
  WAKE_EVENT_TYPE,
  WAKE_EVENT_VERSION,
  mergeWakeDetail,
  wakeEventSchema,
  wakeSummary,
} from "./wake";

/**
 * Posts wake-ups to a Grok Bot routine's webhook (issue #40), safely: every trigger at most once, at most
 * one wake-up per kind per debounce window, at most `dailyCap` per UTC day, retries with backoff on
 * network errors and 5xx (never on 4xx), a bounded queue, and a record of every wake-up for the console.
 * The rules that produce triggers are in wake.ts; the record is a `WakeStore` (SQLite in the console).
 *
 * The webhook's URL and key are secrets (some products put a secret in the URL's path): they live in a
 * `WakeTarget`, are read only to send, and never reach a log line, an error, the record or `status()`.
 */

const REDACTED = "[redacted]";

/** The routine's webhook: where to post and the bearer key. Prints and serializes as `[redacted]`. */
export class WakeTarget {
  readonly #url: string;
  readonly #key: string;

  constructor(url: string, key: string) {
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      // Never the value itself: it may carry the secret.
      throw new Error("the webhook URL must be an http or https URL");
    }
    if (key.trim() === "") throw new Error("the webhook key is empty");
    this.#url = url;
    this.#key = key;
  }

  /** The URL and key, for the request only. */
  reveal(): { url: string; key: string } {
    return { url: this.#url, key: this.#key };
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/**
 * - `queued`: waiting for its time (now, the end of its kind's debounce window, or a retry).
 * - `sending`: a request is in flight.
 * - `sent`: the webhook answered 2xx, so a run started.
 * - `failed`: a 4xx, the last retry failed, or the console stopped while the request was in flight.
 * - `capped`: today's cap was reached when it was due; never sent.
 * - `dropped`: the queue was full when it was offered; never sent.
 */
export type WakeDeliveryStatus = "queued" | "sending" | "sent" | "failed" | "capped" | "dropped";

/** One wake-up as the store keeps it. Times are unix ms. */
export interface WakeDelivery {
  id: string;
  kind: WakeKind;
  status: WakeDeliveryStatus;
  detail: WakeDetail;
  /** Triggers it carries. */
  count: number;
  occurredAt: number;
  createdAt: number;
  dueAt: number;
  attempts: number;
  attemptedAt: number | null;
  sentAt: number | null;
  /** What happened, in a few words: never a URL, key or raw error message. */
  result: string | null;
  /** Whether it used up one of today's wake-ups: sent, in flight, or with an unknown outcome. */
  countsTowardCap: boolean;
}

/** Where wake-ups and the triggers they carry are recorded. Every method is synchronous. */
export interface WakeStore {
  /** Runs `work` atomically. */
  transaction<T>(work: () => T): T;
  hasSource(sourceId: string): boolean;
  addSource(sourceId: string, deliveryId: string, at: number): void;
  insert(delivery: WakeDelivery): void;
  update(delivery: WakeDelivery): void;
  /** The wake-up of `kind` still waiting for its first try, if any. */
  openOfKind(kind: WakeKind): WakeDelivery | null;
  /** Every `queued` wake-up, earliest due first. */
  queued(): WakeDelivery[];
  /** Every `sending` wake-up: after a restart, those whose outcome is unknown. */
  inFlight(): WakeDelivery[];
  /** When a wake-up of `kind` was last tried, or null. */
  lastAttemptAt(kind: WakeKind): number | null;
  /** Wake-ups that count toward the cap, first tried at or after `since`. */
  countedSince(since: number): number;
  /** The newest wake-ups, newest first. */
  recent(limit: number): WakeDelivery[];
}

/** A `WakeStore` in memory, for tests and the red team. */
export class MemoryWakeStore implements WakeStore {
  readonly deliveries = new Map<string, WakeDelivery>();
  readonly sources = new Map<string, string>();

  transaction<T>(work: () => T): T {
    return work();
  }
  hasSource(sourceId: string): boolean {
    return this.sources.has(sourceId);
  }
  addSource(sourceId: string, deliveryId: string): void {
    this.sources.set(sourceId, deliveryId);
  }
  insert(delivery: WakeDelivery): void {
    this.deliveries.set(delivery.id, { ...delivery });
  }
  update(delivery: WakeDelivery): void {
    this.deliveries.set(delivery.id, { ...delivery });
  }
  openOfKind(kind: WakeKind): WakeDelivery | null {
    const open = [...this.deliveries.values()].find(
      (d) => d.kind === kind && d.status === "queued" && d.attempts === 0,
    );
    return open ? { ...open } : null;
  }
  queued(): WakeDelivery[] {
    return [...this.deliveries.values()]
      .filter((d) => d.status === "queued")
      .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt)
      .map((d) => ({ ...d }));
  }
  inFlight(): WakeDelivery[] {
    return [...this.deliveries.values()].filter((d) => d.status === "sending").map((d) => ({ ...d }));
  }
  lastAttemptAt(kind: WakeKind): number | null {
    let last: number | null = null;
    for (const d of this.deliveries.values()) {
      if (d.kind === kind && d.attemptedAt !== null && (last === null || d.attemptedAt > last)) {
        last = d.attemptedAt;
      }
    }
    return last;
  }
  countedSince(since: number): number {
    return [...this.deliveries.values()].filter(
      (d) => d.countsTowardCap && d.attemptedAt !== null && d.attemptedAt >= since,
    ).length;
  }
  recent(limit: number): WakeDelivery[] {
    // Newest first; among equal times, the one inserted last.
    return [...this.deliveries.values()]
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
}

/** A wake-up as the console shows it. Never the webhook's URL or key. */
export interface WakeDeliveryView {
  id: string;
  kind: WakeKind;
  summary: string;
  count: number;
  status: WakeDeliveryStatus;
  result: string | null;
  occurredAt: string;
  /** When it was last tried, or null. */
  attemptedAt: string | null;
  /** While queued: when it will be tried. Once capped: when it was due. */
  dueAt: string | null;
}

export interface WakeStatus {
  /** False when the webhook URL or key is not set: nothing is recorded or sent. */
  enabled: boolean;
  dailyCap: number;
  usedToday: number;
  leftToday: number;
  /** The newest wake-ups, newest first. */
  recent: WakeDeliveryView[];
}

export type WakeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Thrown by a `WakeFetch` that refuses to send at all (for example an address outside the allowlist,
 * issue #112): the wake-up fails at once, is never retried, and records `label`, which must be a fixed
 * phrase that quotes nothing of the address or of any answer.
 */
export class WakeRefused extends Error {
  override readonly name = "WakeRefused";
  constructor(readonly label: string) {
    super(label);
  }
}

/** Runs one request when a slot is free: the bound on requests in flight across notifiers. */
export type WakeGate = <T>(task: () => Promise<T>) => Promise<T>;

/** A `WakeGate` that runs at most `limit` tasks at once, the rest in the order they came. */
export function wakeGate(limit: number): WakeGate {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a whole number of at least 1");
  }
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else {
      running += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      // The slot passes to the next task as it is; otherwise it is freed.
      if (next) next();
      else running -= 1;
    }
  };
}

export interface WakeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface WakeNotifierOptions {
  /** Null turns the notifier off. `setTarget` changes it later. */
  target: WakeTarget | null;
  dailyCap: number;
  store: WakeStore;
  /** The console's public address, for each wake-up's link. */
  publicUrl?: string | null;
  fetch?: WakeFetch;
  now?: () => number;
  /** Runs `task` after `ms`; returns a cancel function. Tests pass a simulated clock's. */
  schedule?: (task: () => void, ms: number) => () => void;
  logger?: WakeLogger;
  /** Per request. */
  timeoutMs?: number;
  /** Waits before each retry; the number of entries is the number of retries. */
  retryDelaysMs?: readonly number[];
  /** Most wake-ups waiting at once. */
  maxQueued?: number;
  /** Called after the record changed (a wake-up was queued, sent, failed or capped). */
  onChange?: () => void;
  /** Shared by every notifier of a process, so many webhooks never mean unbounded requests at once. */
  gate?: WakeGate;
}

const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Four retries after the first try: about 2.5 minutes before giving up. */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000];
/** At most one open wake-up per kind waits at a time, plus retries; this bounds the rest. */
export const WAKE_MAX_QUEUED = 16;
const RECENT = 5;

function defaultSchedule(task: () => void, ms: number): () => void {
  const timer = setTimeout(task, ms);
  // Never keeps a process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
  };
}

/** A stable id per first trigger: `wk_` and 24 hex digits (FNV-1a, two lanes). */
export function wakeId(sourceId: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ sourceId.length;
  let c = 0x9e3779b9;
  for (let i = 0; i < sourceId.length; i++) {
    const code = sourceId.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    c = Math.imul(c ^ (code + i), 0x27d4eb2d);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `wk_${hex(a)}${hex(b)}${hex(c)}`;
}

export class WakeNotifier {
  private readonly store: WakeStore;
  private readonly now: () => number;
  private readonly fetch: WakeFetch;
  private readonly schedule: (task: () => void, ms: number) => () => void;
  private readonly retryDelays: readonly number[];
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly publicUrl: string | null;
  private lastAgentActivity: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private timerAt: number | null = null;
  private pumping: Promise<void> | null = null;
  private stopped = true;
  private target: WakeTarget | null;

  constructor(private readonly options: WakeNotifierOptions) {
    this.target = options.target;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.schedule = options.schedule ?? defaultSchedule;
    this.retryDelays = options.retryDelaysMs ?? WAKE_RETRY_DELAYS_MS;
    this.maxQueued = options.maxQueued ?? WAKE_MAX_QUEUED;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.publicUrl = options.publicUrl?.replace(/\/+$/, "") ?? null;
    if (!Number.isSafeInteger(options.dailyCap) || options.dailyCap < 0) {
      throw new RangeError("dailyCap must be a whole number of at least 0");
    }
  }

  get enabled(): boolean {
    return this.target !== null;
  }

  /**
   * Points the notifier at another webhook, or turns it off (null). Wake-ups still waiting are never sent
   * to the new address: they were offered for the old one, so they fail as "not sent". A request in flight
   * finishes against the address it started with.
   */
  setTarget(target: WakeTarget | null): void {
    const wasEnabled = this.enabled;
    this.target = target;
    const waiting = wasEnabled ? this.store.queued() : [];
    if (waiting.length > 0) {
      const at = this.now();
      this.store.transaction(() => {
        for (const delivery of waiting) {
          this.store.update({
            ...delivery,
            status: "failed",
            dueAt: at,
            result: "not sent: the webhook changed",
          });
        }
      });
      this.options.onChange?.();
    }
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerAt = null;
    this.arm();
  }

  /**
   * Starts sending. A wake-up that was in flight when the process stopped is marked failed and never
   * sent again: it may have started a run, and a second run is the costlier mistake.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.enabled) return;
    const at = this.now();
    this.store.transaction(() => {
      for (const delivery of this.store.inFlight()) {
        this.store.update({
          ...delivery,
          status: "failed",
          result: "outcome unknown: the console stopped during the request",
          countsTowardCap: true,
          dueAt: at,
        });
      }
    });
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerAt = null;
  }

  /** The agent's MCP server called the console: a Bot run is in progress for `RUN_QUIET_MS`. */
  noteAgentActivity(at: number = this.now()): void {
    if (this.lastAgentActivity === null || at > this.lastAgentActivity) this.lastAgentActivity = at;
  }

  runInProgress(at: number = this.now()): boolean {
    return this.lastAgentActivity !== null && at - this.lastAgentActivity < RUN_QUIET_MS;
  }

  /**
   * Records triggers and schedules their wake-ups. A trigger seen before is ignored. A trigger whose kind
   * already has a wake-up waiting joins it; otherwise it gets a wake-up of its own, due now or when its
   * kind's debounce window ends. Does nothing while the notifier is off.
   */
  offer(candidates: readonly WakeCandidate[]): void {
    if (!this.enabled || candidates.length === 0) return;
    const at = this.now();
    this.store.transaction(() => {
      for (const candidate of candidates) this.offerOne(candidate, at);
    });
    this.options.onChange?.();
    this.arm();
  }

  private offerOne(candidate: WakeCandidate, at: number): void {
    if (this.store.hasSource(candidate.sourceId)) return;
    const detail = { kind: candidate.kind, detail: candidate.detail } as WakeDetail;
    const open = this.store.openOfKind(candidate.kind);
    if (open) {
      this.store.update({
        ...open,
        detail: mergeWakeDetail(open.detail, detail),
        count: open.count + 1,
        occurredAt: Math.max(open.occurredAt, candidate.occurredAt),
      });
      this.store.addSource(candidate.sourceId, open.id, at);
      return;
    }
    const id = wakeId(candidate.sourceId);
    const full = this.store.queued().length >= this.maxQueued;
    const last = this.store.lastAttemptAt(candidate.kind);
    const dueAt = Math.max(at, last === null ? at : last + WAKE_DEBOUNCE_MS[candidate.kind]);
    this.store.insert({
      id,
      kind: candidate.kind,
      status: full ? "dropped" : "queued",
      detail,
      count: 1,
      occurredAt: candidate.occurredAt,
      createdAt: at,
      dueAt,
      attempts: 0,
      attemptedAt: null,
      sentAt: null,
      result: full ? "too many wake-ups were waiting" : null,
      countsTowardCap: false,
    });
    this.store.addSource(candidate.sourceId, id, at);
    if (full) this.log("warn", `wake-up ${id} (${candidate.kind}) dropped: the queue is full`);
  }

  /** Sends every wake-up that is due now, one at a time. Resolves when none is left due. */
  flush(): Promise<void> {
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
      this.arm();
    });
    return this.pumping;
  }

  /** The wake-ups the console shows and today's count. */
  status(): WakeStatus {
    const used = this.enabled ? this.usedToday(this.now()) : 0;
    const cap = this.options.dailyCap;
    return {
      enabled: this.enabled,
      dailyCap: cap,
      usedToday: used,
      leftToday: Math.max(0, cap - used),
      recent: this.enabled ? this.store.recent(RECENT).map((d) => this.view(d)) : [],
    };
  }

  /** The body a delivery is posted with on its next try. */
  body(delivery: WakeDelivery, sentAt: number, attempt: number): WakeEvent {
    return {
      type: WAKE_EVENT_TYPE,
      version: WAKE_EVENT_VERSION,
      id: delivery.id,
      occurredAt: new Date(delivery.occurredAt).toISOString(),
      sentAt: new Date(sentAt).toISOString(),
      attempt,
      count: delivery.count,
      summary: wakeSummary(delivery.detail, delivery.count),
      link: this.link(delivery.detail),
      ...delivery.detail,
    };
  }

  // ---------------------------------------------------------------- internals

  private usedToday(at: number): number {
    return this.store.countedSince(Math.floor(at / DAY_MS) * DAY_MS);
  }

  private view(delivery: WakeDelivery): WakeDeliveryView {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      id: delivery.id,
      kind: delivery.kind,
      summary: wakeSummary(delivery.detail, delivery.count),
      count: delivery.count,
      status: delivery.status,
      result: delivery.result,
      occurredAt: new Date(delivery.occurredAt).toISOString(),
      attemptedAt: iso(delivery.attemptedAt),
      dueAt: delivery.status === "queued" || delivery.status === "capped" ? iso(delivery.dueAt) : null,
    };
  }

  private link(detail: WakeDetail): string | null {
    if (this.publicUrl === null) return null;
    switch (detail.kind) {
      case "price_below_floor":
      case "cover_lost":
      case "ladder_settled":
        return `${this.publicUrl}/hedge`;
      case "mandate_changed":
        return `${this.publicUrl}/rules`;
      default: {
        const latest = detail.detail.intents.at(-1);
        return latest ? `${this.publicUrl}/activity/${String(latest.id)}` : `${this.publicUrl}/activity`;
      }
    }
  }

  /** Sets one timer for the earliest queued wake-up; none while nothing waits. */
  private arm(): void {
    if (this.stopped || !this.enabled || this.pumping) return;
    const next = this.store.queued()[0];
    if (!next) {
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.timerAt = null;
      return;
    }
    if (this.timerAt !== null && this.timerAt <= next.dueAt) return;
    this.cancelTimer?.();
    const delay = Math.max(0, Math.min(next.dueAt - this.now(), 2 ** 31 - 1));
    this.timerAt = next.dueAt;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.timerAt = null;
      void this.flush();
    }, delay);
  }

  private async pump(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.enabled) return;
      const at = this.now();
      const due = this.store.queued().find((d) => d.dueAt <= at);
      if (!due) return;
      await this.deliver(due, at);
      this.options.onChange?.();
    }
  }

  private async deliver(delivery: WakeDelivery, at: number): Promise<void> {
    if (this.usedToday(at) >= this.options.dailyCap) {
      this.store.update({ ...delivery, status: "capped", result: "today's cap was reached" });
      this.log("warn", `wake-up ${delivery.id} (${delivery.kind}) not sent: today's cap was reached`);
      return;
    }
    const attempt = delivery.attempts + 1;
    const sending: WakeDelivery = {
      ...delivery,
      status: "sending",
      attempts: attempt,
      attemptedAt: at,
      countsTowardCap: true,
    };
    this.store.update(sending);

    const outcome = await this.post(this.body(sending, at, attempt));
    const retryIn = this.retryDelays[attempt - 1];
    const done = this.now();
    if (outcome.kind === "sent") {
      this.store.update({ ...sending, status: "sent", sentAt: done, result: outcome.label });
      this.log("info", `wake-up ${delivery.id} (${delivery.kind}) sent: ${outcome.label}`);
    } else if (outcome.kind === "refused" || retryIn === undefined) {
      const tries = attempt > 1 ? ` after ${String(attempt)} tries` : "";
      this.store.update({
        ...sending,
        status: "failed",
        result: `${outcome.label}${outcome.kind === "refused" ? ", not retried" : `, gave up${tries}`}`,
        // A timeout may have started a run; anything else answered or never connected.
        countsTowardCap: outcome.kind === "unknown",
      });
      this.log("warn", `wake-up ${delivery.id} (${delivery.kind}) failed: ${outcome.label}`);
    } else {
      this.store.update({
        ...sending,
        status: "queued",
        dueAt: done + retryIn,
        result: `${outcome.label}, retrying`,
        countsTowardCap: outcome.kind === "unknown",
      });
      this.log("warn", `wake-up ${delivery.id} (${delivery.kind}): ${outcome.label}, retrying`);
    }
  }

  /**
   * One POST. The answer is reduced to a few words: a raw error can name the host or the URL, so it is
   * never kept. `unknown` (a timeout) may have started a run; `failed` did not.
   */
  private async post(
    body: WakeEvent,
  ): Promise<{ kind: "sent" | "refused" | "failed" | "unknown"; label: string }> {
    const target = this.target;
    if (!target) return { kind: "refused", label: "off" };
    wakeEventSchema.parse(body);
    const { url, key } = target.reveal();
    const send = () =>
      this.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        // A redirect is never followed: the key must not travel to an address nobody configured.
        redirect: "manual",
        // Started inside the slot, so waiting for one never eats into the request's own time.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    try {
      const response = await (this.options.gate ? this.options.gate(send) : send());
      await response.body?.cancel().catch(() => undefined);
      const label = `HTTP ${String(response.status)}`;
      if (response.status >= 200 && response.status < 300) return { kind: "sent", label };
      if (response.status >= 500) return { kind: "failed", label };
      // 4xx, and a redirect: the request is wrong as configured, and the same request would fail again.
      return { kind: "refused", label };
    } catch (error) {
      if (error instanceof WakeRefused) return { kind: "refused", label: error.label };
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { kind: "unknown", label: "timed out" };
      return { kind: "failed", label: "network error" };
    }
  }

  private log(level: "info" | "warn", message: string): void {
    this.options.logger?.[level](message);
  }
}
