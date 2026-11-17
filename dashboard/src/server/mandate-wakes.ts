import "server-only";

import { type WakeFetch, WakeTarget, wakeGate } from "@mandate/shared";
import {
  type WebhookPolicy,
  type WebhookRefusal,
  type WebhookResolver,
  type WebhookTransport,
  guardedWakeFetch,
  vetWebhookUrl,
} from "@mandate/shared/node";

import type { AgentWebhookView, WakeWebhookSettings } from "@/lib/accounts/types";
import type { ConsoleWakeStatus } from "@/lib/live/types";

import { type MasterKey, openWebhook, sealWebhook } from "./accounts/keys";
import type { Agent } from "./accounts/store";
import type { ConsoleConfig } from "./config";
import type { Database } from "./db";
import { AgentWebhookStore } from "./store/agent-webhooks";
import { ConsoleWake, type LadderSource, NO_WAKE_TARGET_REASON, wakeOffStatus } from "./wake";

/** Most wake-up requests in flight at once, across every mandate: each notifier sends one at a time. */
export const WAKE_CONCURRENCY = 8;

/** Why a stored webhook is not used: it does not open with this console's master key. */
export const UNREADABLE_WEBHOOK_REASON =
  "The console could not read this agent's webhook (it was set under another master key). Set it again.";

/** What `MandateWakes` needs from the console. */
export interface MandateWakesDeps {
  config: ConsoleConfig;
  db: Database;
  master: () => MasterKey;
  /** The mandate on the server's contract: the settings' webhook is its default. */
  envMandateId: string;
  agentOf: (mandateId: string) => Agent;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  onChange: (mandateId: string) => void;
  ladder?: LadderSource;
  /** How the settings' webhook is posted; tests pass their own. */
  envFetch?: WakeFetch;
  /** How agents' webhooks resolve names and send; tests pass their own, and every check still runs. */
  resolve?: WebhookResolver;
  transport?: WebhookTransport;
  now?: () => number;
  schedule?: (task: () => void, ms: number) => () => void;
}

/** A refusal of an agent's webhook, as the Setup page shows it. */
export class WebhookRefused extends Error {
  override readonly name = "WebhookRefused";
  constructor(readonly reason: WebhookRefusal | "off") {
    super(reason);
  }
}

/**
 * Every mandate's event wake-ups (#112). Each mandate whose agent has a webhook (and the mandate on the
 * server's contract, whose default is the webhook in the settings) gets a `ConsoleWake` of its own: its
 * own cap, debounce windows, price memory and queue, posting to that agent's webhook only. They share one
 * bound on requests in flight (`WAKE_CONCURRENCY`), and each sends one request at a time, so a webhook
 * that hangs holds one slot for at most its time limit and never delays another mandate's queue.
 *
 * An agent's webhook is sealed under the master key, bound to the agent and its host, and opened only to
 * build the target, which prints as `[redacted]`. Its address is checked when it is set and again on every
 * send (`guardedWakeFetch`).
 */
export class MandateWakes {
  readonly webhooks: AgentWebhookStore;
  private readonly wakes = new Map<string, ConsoleWake>();
  private readonly gate = wakeGate(WAKE_CONCURRENCY);
  private readonly guarded: WakeFetch;
  private readonly envSend: WakeFetch;
  /** Agents whose stored webhook did not open: off, with a reason to set it again. */
  private readonly unreadable = new Set<string>();
  private running = false;

  constructor(private readonly deps: MandateWakesDeps) {
    this.webhooks = new AgentWebhookStore(deps.db);
    this.guarded = guardedWakeFetch(() => this.policy, {
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
      ...(deps.transport ? { transport: deps.transport } : {}),
    });
    this.envSend = deps.envFetch ?? ((url, init) => fetch(url, init));
  }

  /** Where agents' webhooks may point. */
  get policy(): WebhookPolicy {
    return { hosts: this.deps.config.wake.webhookHosts, allowLocal: this.deps.config.wake.testReceivers };
  }

  get settings(): WakeWebhookSettings {
    const hosts = [...this.deps.config.wake.webhookHosts];
    return { enabled: hosts.length > 0, hosts };
  }

  /** The wake-ups of the mandate on the server's contract (tests and the dev clock wait on it). */
  get env(): ConsoleWake {
    return this.ensure(this.deps.envMandateId);
  }

  /** The mandate's wake-ups, or null while it has no webhook at all. */
  of(mandateId: string): ConsoleWake | null {
    const existing = this.wakes.get(mandateId);
    if (existing) return existing;
    if (mandateId !== this.deps.envMandateId && !this.webhooks.get(this.deps.agentOf(mandateId).id)) {
      return null;
    }
    return this.ensure(mandateId);
  }

  /** Starts the wake-ups of the env mandate and of every agent with a webhook. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.ensure(this.deps.envMandateId);
    for (const row of this.webhooks.all()) {
      const mandateId = this.mandateOfAgent(row.agentId);
      if (mandateId) this.ensure(mandateId);
    }
    for (const wake of this.wakes.values()) wake.start();
  }

  stop(): void {
    this.running = false;
    for (const wake of this.wakes.values()) wake.stop();
  }

  /** Resolves when every mandate's price check and due wake-ups are done. For tests. */
  async settled(): Promise<void> {
    await Promise.all([...this.wakes.values()].map((wake) => wake.settled()));
  }

  status(mandateId: string): ConsoleWakeStatus {
    return this.of(mandateId)?.status() ?? wakeOffStatus(this.deps.config, NO_WAKE_TARGET_REASON);
  }

  /** The agent's webhook as the Setup page shows it. Never the address or the key. */
  view(agent: Agent): AgentWebhookView {
    const row = this.webhooks.get(agent.id);
    const since = row?.setAt ?? null;
    const isEnv = agent.mandateId === this.deps.envMandateId;
    const source = row ? "agent" : isEnv && this.deps.config.wake.target ? "default" : "none";
    let lastDelivery: AgentWebhookView["lastDelivery"] = null;
    if (source !== "none") {
      const last = this.webhooks.lastDelivery(agent.mandateId, since ?? 0);
      lastDelivery = last
        ? { at: new Date(last.at).toISOString(), status: last.status, result: last.result }
        : null;
    }
    return {
      source,
      host: row?.host ?? null,
      setAt: since === null ? null : new Date(since).toISOString(),
      lastDelivery,
      unreadable: this.unreadable.has(agent.id),
    };
  }

  /**
   * Checks an address and key for `agent` without storing anything: the host it would show, or why it is
   * refused. Refuses when no host is allowed.
   */
  async vet(url: string): Promise<{ host: string }> {
    if (!this.settings.enabled) throw new WebhookRefused("off");
    const vetted = await vetWebhookUrl(url, this.policy, this.deps.resolve);
    if (!vetted.ok) throw new WebhookRefused(vetted.reason);
    return { host: vetted.host };
  }

  /** Seals and stores the agent's webhook (set or replace) and points its mandate's wake-ups at it. */
  set(agent: Agent, secret: { url: string; key: string }, host: string, memberId: string): void {
    const target = new WakeTarget(secret.url, secret.key);
    const sealed = sealWebhook(this.deps.master(), agent.id, host, secret);
    this.webhooks.set({ agentId: agent.id, host, sealed, setBy: memberId, setAt: this.now() });
    this.unreadable.delete(agent.id);
    const wake = this.ensure(agent.mandateId);
    wake.retarget(target, null, this.guarded);
    if (this.running) wake.start();
  }

  /** Removes the agent's webhook: its mandate falls back to the settings' webhook, or stops. */
  remove(agent: Agent): boolean {
    const removed = this.webhooks.remove(agent.id);
    this.unreadable.delete(agent.id);
    const wake = this.wakes.get(agent.mandateId);
    if (wake) {
      const fallback = this.fallback(agent.mandateId);
      wake.retarget(fallback.target, fallback.offReason, fallback.send);
    }
    return removed;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private mandateOfAgent(agentId: string): string | null {
    // The agents' table names its mandate; the store reads it through `agentOf` by mandate, so look it up.
    const row = this.deps.db.prepare("SELECT mandate_id FROM agents WHERE id = ?").get(agentId) as
      { mandate_id: string } | undefined;
    return row?.mandate_id ?? null;
  }

  /** The settings' webhook for the env mandate; nothing for any other. */
  private fallback(mandateId: string): {
    target: WakeTarget | null;
    offReason: string | null;
    send: WakeFetch;
  } {
    if (mandateId === this.deps.envMandateId) {
      return {
        target: this.deps.config.wake.target,
        offReason: this.deps.config.wake.offReason,
        send: this.envSend,
      };
    }
    return { target: null, offReason: NO_WAKE_TARGET_REASON, send: this.guarded };
  }

  /** Where the mandate's wake-ups go now: its agent's webhook, else the fallback. */
  private current(mandateId: string): {
    target: WakeTarget | null;
    offReason: string | null;
    send: WakeFetch;
  } {
    const agent = this.deps.agentOf(mandateId);
    const row = this.webhooks.get(agent.id);
    if (!row) return this.fallback(mandateId);
    try {
      const secret = openWebhook(this.deps.master(), agent.id, row.host, row.sealed);
      this.unreadable.delete(agent.id);
      return { target: new WakeTarget(secret.url, secret.key), offReason: null, send: this.guarded };
    } catch {
      // Never the error's text: only that it did not open, for this mandate alone.
      this.unreadable.add(agent.id);
      this.deps.logger.warn(
        `mandate ${mandateId}: its agent's webhook could not be opened; wake-ups are off`,
      );
      return { target: null, offReason: UNREADABLE_WEBHOOK_REASON, send: this.guarded };
    }
  }

  private ensure(mandateId: string): ConsoleWake {
    const existing = this.wakes.get(mandateId);
    if (existing) return existing;
    const current = this.current(mandateId);
    const wake = new ConsoleWake(this.deps.config, this.deps.db, mandateId, {
      target: current.target,
      offReason: current.offReason,
      fetch: current.send,
      gate: this.gate,
      logger: {
        info: (message) => this.deps.logger.info(`mandate ${mandateId}: ${message}`),
        warn: (message) => this.deps.logger.warn(`mandate ${mandateId}: ${message}`),
      },
      onChange: () => {
        this.deps.onChange(mandateId);
      },
      ...(this.deps.ladder ? { ladder: this.deps.ladder } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.schedule ? { schedule: this.deps.schedule } : {}),
    });
    this.wakes.set(mandateId, wake);
    if (this.running) wake.start();
    return wake;
  }
}
