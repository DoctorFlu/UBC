import "server-only";

import {
  type Intent,
  type PolicyEvent,
  compareEvents,
  intentSchema,
  policyEventSchema,
} from "@mandate/shared";

import { type Database, transaction } from "../db";

export type IngestSource = "rpc" | "stream";

/**
 * Policy contract events and what was read alongside them, per deployment. Every write is idempotent:
 * an event is identified by its transaction hash and log index, so a repeated Stream delivery or an
 * overlapping RPC scan changes nothing.
 */
export class EventStore {
  constructor(private readonly db: Database) {}

  /** Stores the events not seen before and returns those, in chain order. */
  insert(deploymentId: string, events: readonly PolicyEvent[], source: IngestSource): PolicyEvent[] {
    if (events.length === 0) return [];
    return transaction(this.db, () => this.insertWithoutTransaction(deploymentId, events, source));
  }

  /** Every stored event of a deployment, in chain order. */
  list(deploymentId: string): PolicyEvent[] {
    const rows = this.db
      .prepare("SELECT payload FROM policy_events WHERE deployment_id = ? ORDER BY block_number, log_index")
      .all(deploymentId) as { payload: string }[];
    return rows.map((row) => policyEventSchema.parse(JSON.parse(row.payload)));
  }

  /** The first block not yet scanned by the RPC source, or null when it never ran. */
  cursor(deploymentId: string): bigint | null {
    const row = this.db
      .prepare("SELECT next_block FROM ingest_cursors WHERE deployment_id = ?")
      .get(deploymentId) as { next_block: number } | undefined;
    return row ? BigInt(row.next_block) : null;
  }

  /** Stores events and moves the cursor in one transaction, so a crash never skips a block. */
  insertScanned(deploymentId: string, events: readonly PolicyEvent[], nextBlock: bigint): PolicyEvent[] {
    return transaction(this.db, () => {
      const added = this.insertWithoutTransaction(deploymentId, events, "rpc");
      this.db
        .prepare(
          `INSERT INTO ingest_cursors (deployment_id, next_block, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (deployment_id) DO UPDATE SET next_block = excluded.next_block, updated_at = excluded.updated_at`,
        )
        .run(deploymentId, Number(nextBlock), new Date().toISOString());
      return added;
    });
  }

  /** Stored `getIntent` reads. They never change once an intent exists. */
  intentDetails(deploymentId: string): Map<number, Intent> {
    const rows = this.db
      .prepare("SELECT payload FROM intent_details WHERE deployment_id = ?")
      .all(deploymentId) as { payload: string }[];
    const details = new Map<number, Intent>();
    for (const row of rows) {
      const intent = intentSchema.parse(JSON.parse(row.payload));
      details.set(intent.id, intent);
    }
    return details;
  }

  saveIntentDetails(deploymentId: string, intents: readonly Intent[]): void {
    if (intents.length === 0) return;
    const statement = this.db.prepare(
      "INSERT OR REPLACE INTO intent_details (deployment_id, intent_id, payload) VALUES (?, ?, ?)",
    );
    transaction(this.db, () => {
      for (const intent of intents) statement.run(deploymentId, intent.id, JSON.stringify(intent));
    });
  }

  private insertWithoutTransaction(
    deploymentId: string,
    events: readonly PolicyEvent[],
    source: IngestSource,
  ): PolicyEvent[] {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO policy_events
         (deployment_id, tx_hash, log_index, block_number, block_timestamp, type, payload, source, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const receivedAt = new Date().toISOString();
    const added: PolicyEvent[] = [];
    for (const event of events) {
      const result = statement.run(
        deploymentId,
        event.transactionHash.toLowerCase(),
        event.logIndex,
        event.blockNumber,
        event.blockTimestamp,
        event.type,
        JSON.stringify(event),
        source,
        receivedAt,
      );
      if (Number(result.changes) > 0) added.push(event);
    }
    return added.sort(compareEvents);
  }
}
