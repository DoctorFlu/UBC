import "server-only";

import type { Address, Hex } from "viem";

import type { Database } from "../db";

/**
 * A settlement as stored: the document is raw JSON, so a read can check it still hashes to `hash`, the
 * way decision contexts are checked. The signature was checked against the contract's executor before
 * the row was written.
 */
export interface SettlementRow {
  intentId: number;
  hash: Hex;
  document: unknown;
  signature: Hex;
  signer: Address;
  storedAt: string;
}

interface Row {
  intent_id: number;
  hash: string;
  document: string;
  signature: string;
  signer: string;
  stored_at: string;
}

function fromRow(row: Row): SettlementRow {
  let document: unknown;
  try {
    document = JSON.parse(row.document);
  } catch {
    document = row.document;
  }
  return {
    intentId: row.intent_id,
    hash: row.hash as Hex,
    document,
    signature: row.signature as Hex,
    signer: row.signer as Address,
    storedAt: row.stored_at,
  };
}

export type PutSettlementResult =
  { ok: true; row: SettlementRow; created: boolean } | { ok: false; existing: SettlementRow };

/**
 * What each filled position paid when its market resolved, per deployment and intent, as the executor
 * signed it (issue #92). The Policy contract cannot record this, so the console is the system of record.
 * The first record of an intent wins and is never rewritten: the same record again is a no-op, and a
 * different one is refused.
 */
export class SettlementStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  put(
    deploymentId: string,
    record: { intentId: number; hash: Hex; document: unknown; signature: Hex; signer: Address },
  ): PutSettlementResult {
    const hash = record.hash.toLowerCase() as Hex;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO settlements
           (deployment_id, intent_id, hash, document, signature, signer, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deploymentId,
        record.intentId,
        hash,
        JSON.stringify(record.document),
        record.signature.toLowerCase(),
        record.signer,
        this.now().toISOString(),
      );
    const row = this.get(deploymentId, record.intentId);
    if (!row) throw new Error(`settlement of intent ${String(record.intentId)} vanished after insert`);
    if (row.hash !== hash) return { ok: false, existing: row };
    return { ok: true, row, created: Number(result.changes) > 0 };
  }

  get(deploymentId: string, intentId: number): SettlementRow | null {
    const row = this.db
      .prepare("SELECT * FROM settlements WHERE deployment_id = ? AND intent_id = ?")
      .get(deploymentId, intentId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Every settlement of a deployment, newest first. */
  list(deploymentId: string): SettlementRow[] {
    const rows = this.db
      .prepare("SELECT * FROM settlements WHERE deployment_id = ? ORDER BY stored_at DESC, intent_id DESC")
      .all(deploymentId) as unknown as Row[];
    return rows.map(fromRow);
  }
}
