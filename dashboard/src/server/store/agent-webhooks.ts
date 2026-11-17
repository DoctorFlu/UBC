import "server-only";

import type { WakeDeliveryStatus } from "@mandate/shared";

import type { Database } from "../db";

/** An agent's routine webhook as stored (#112): the host in the clear, the address and key sealed. */
export interface AgentWebhookRow {
  agentId: string;
  host: string;
  /** `sealWebhook`'s JSON: no secret in the clear. */
  sealed: string;
  /** The member who set it with their passkey. */
  setBy: string;
  /** Unix ms on the wake-ups' clock. */
  setAt: number;
}

interface Row {
  agent_id: string;
  host: string;
  sealed: string;
  set_by: string;
  set_at: number;
}

function toRow(row: Row): AgentWebhookRow {
  return { agentId: row.agent_id, host: row.host, sealed: row.sealed, setBy: row.set_by, setAt: row.set_at };
}

/** The agents' webhooks (table `agent_webhooks`, migration 10), and the last wake-up each one was sent. */
export class AgentWebhookStore {
  constructor(private readonly db: Database) {}

  get(agentId: string): AgentWebhookRow | null {
    const row = this.db.prepare("SELECT * FROM agent_webhooks WHERE agent_id = ?").get(agentId) as
      Row | undefined;
    return row ? toRow(row) : null;
  }

  all(): AgentWebhookRow[] {
    return (this.db.prepare("SELECT * FROM agent_webhooks ORDER BY set_at").all() as unknown as Row[]).map(
      toRow,
    );
  }

  /** Sets or replaces the agent's webhook. */
  set(row: AgentWebhookRow): void {
    this.db
      .prepare(
        `INSERT INTO agent_webhooks (agent_id, host, sealed, set_by, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET host = excluded.host, sealed = excluded.sealed,
           set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(row.agentId, row.host, row.sealed, row.setBy, row.setAt);
  }

  /** Removes the agent's webhook; false when it had none. */
  remove(agentId: string): boolean {
    return Number(this.db.prepare("DELETE FROM agent_webhooks WHERE agent_id = ?").run(agentId).changes) > 0;
  }

  /**
   * The newest wake-up of `mandateId` tried, or held back by the daily cap, at or after `since` (unix ms):
   * its time, status and the few words recorded about it. Never its body or anything the webhook
   * answered, which is never stored.
   */
  lastDelivery(
    mandateId: string,
    since: number,
  ): { at: number; status: WakeDeliveryStatus; result: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(attempted_at, due_at) AS at, status, result FROM wake_deliveries
         WHERE mandate_id = ? AND (attempted_at IS NOT NULL OR status = 'capped')
           AND COALESCE(attempted_at, due_at) >= ?
         ORDER BY at DESC, rowid DESC LIMIT 1`,
      )
      .get(mandateId, since) as { at: number; status: WakeDeliveryStatus; result: string | null } | undefined;
    return row ? { at: row.at, status: row.status, result: row.result } : null;
  }
}
