import "server-only";

import {
  type PriceMemory,
  type WakeDelivery,
  type WakeDeliveryStatus,
  type WakeKind,
  type WakeStore,
  wakeDetailSchema,
} from "@mandate/shared";

import type { Database } from "../db";

interface DeliveryRow {
  id: string;
  kind: string;
  status: string;
  detail: string;
  count: number;
  occurred_at: number;
  created_at: number;
  due_at: number;
  attempts: number;
  attempted_at: number | null;
  sent_at: number | null;
  result: string | null;
  counts_toward_cap: number;
}

function fromRow(row: DeliveryRow): WakeDelivery {
  return {
    id: row.id,
    kind: row.kind as WakeKind,
    status: row.status as WakeDeliveryStatus,
    detail: wakeDetailSchema.parse(JSON.parse(row.detail)),
    count: row.count,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    dueAt: row.due_at,
    attempts: row.attempts,
    attemptedAt: row.attempted_at,
    sentAt: row.sent_at,
    result: row.result,
    countsTowardCap: row.counts_toward_cap === 1,
  };
}

/** How long sent wake-ups and the triggers they carried are kept. */
const KEEP_MS = 30 * 86_400_000;

/**
 * One mandate's record of event wake-ups (`WakeStore` of `@mandate/shared`), in the console's SQLite file,
 * so a restart neither resends a wake-up nor forgets a trigger it already handled. Holds no URL or key.
 * Every read and write is limited to `mandateId`, including the daily cap's count.
 */
export class SqliteWakeStore implements WakeStore {
  private depth = 0;

  constructor(
    private readonly db: Database,
    readonly mandateId: string,
  ) {}

  /** Re-entrant: the notifier's transactions may run inside the caller's. */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  hasSource(sourceId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM wake_sources WHERE mandate_id = ? AND source_id = ?")
        .get(this.mandateId, sourceId) !== undefined
    );
  }

  addSource(sourceId: string, deliveryId: string, at: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO wake_sources (mandate_id, source_id, delivery_id, seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(this.mandateId, sourceId, deliveryId, at);
  }

  insert(delivery: WakeDelivery): void {
    this.db
      .prepare(
        `INSERT INTO wake_deliveries
           (mandate_id, id, kind, status, detail, count, occurred_at, created_at, due_at, attempts, attempted_at,
            sent_at, result, counts_toward_cap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.mandateId, ...this.values(delivery));
  }

  update(delivery: WakeDelivery): void {
    const [id, ...rest] = this.values(delivery);
    this.db
      .prepare(
        `UPDATE wake_deliveries SET kind = ?, status = ?, detail = ?, count = ?, occurred_at = ?, created_at = ?,
           due_at = ?, attempts = ?, attempted_at = ?, sent_at = ?, result = ?, counts_toward_cap = ?
         WHERE mandate_id = ? AND id = ?`,
      )
      .run(...rest, this.mandateId, id);
  }

  openOfKind(kind: WakeKind): WakeDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM wake_deliveries WHERE mandate_id = ? AND kind = ? AND status = 'queued' AND attempts = 0
         ORDER BY created_at LIMIT 1`,
      )
      .get(this.mandateId, kind) as DeliveryRow | undefined;
    return row ? fromRow(row) : null;
  }

  queued(): WakeDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM wake_deliveries WHERE mandate_id = ? AND status = 'queued'
         ORDER BY due_at, created_at, rowid`,
      )
      .all(this.mandateId) as unknown as DeliveryRow[];
    return rows.map(fromRow);
  }

  inFlight(): WakeDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM wake_deliveries WHERE mandate_id = ? AND status = 'sending'")
      .all(this.mandateId) as unknown as DeliveryRow[];
    return rows.map(fromRow);
  }

  lastAttemptAt(kind: WakeKind): number | null {
    const row = this.db
      .prepare("SELECT MAX(attempted_at) AS at FROM wake_deliveries WHERE mandate_id = ? AND kind = ?")
      .get(this.mandateId, kind) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  countedSince(since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM wake_deliveries
         WHERE mandate_id = ? AND counts_toward_cap = 1 AND attempted_at >= ?`,
      )
      .get(this.mandateId, since) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  recent(limit: number): WakeDelivery[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM wake_deliveries WHERE mandate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(this.mandateId, limit) as unknown as DeliveryRow[];
    return rows.map(fromRow);
  }

  /** What the last price check of a goal saw, or null before its first. */
  priceMemory(planId: string): PriceMemory | null {
    const row = this.db
      .prepare("SELECT memory FROM wake_price_memory WHERE mandate_id = ? AND plan_id = ?")
      .get(this.mandateId, planId) as { memory: string } | undefined;
    return row ? (JSON.parse(row.memory) as PriceMemory) : null;
  }

  savePriceMemory(planId: string, memory: PriceMemory, at: number): void {
    this.db
      .prepare(
        `INSERT INTO wake_price_memory (mandate_id, plan_id, memory, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (mandate_id, plan_id) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`,
      )
      .run(this.mandateId, planId, JSON.stringify(memory), at);
  }

  /** Forgets finished wake-ups, their triggers and goals not checked for `KEEP_MS`. */
  prune(now: number): void {
    const before = now - KEEP_MS;
    this.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM wake_sources WHERE mandate_id = ? AND delivery_id IN (
             SELECT id FROM wake_deliveries
             WHERE mandate_id = ? AND created_at < ? AND status NOT IN ('queued', 'sending'))`,
        )
        .run(this.mandateId, this.mandateId, before);
      this.db
        .prepare(
          `DELETE FROM wake_deliveries
           WHERE mandate_id = ? AND created_at < ? AND status NOT IN ('queued', 'sending')`,
        )
        .run(this.mandateId, before);
      this.db
        .prepare("DELETE FROM wake_price_memory WHERE mandate_id = ? AND updated_at < ?")
        .run(this.mandateId, before);
    });
  }

  private values(d: WakeDelivery) {
    return [
      d.id,
      d.kind,
      d.status,
      JSON.stringify({ kind: d.detail.kind, detail: d.detail.detail }),
      d.count,
      d.occurredAt,
      d.createdAt,
      d.dueAt,
      d.attempts,
      d.attemptedAt,
      d.sentAt,
      d.result,
      d.countsTowardCap ? 1 : 0,
    ] as const;
  }
}
