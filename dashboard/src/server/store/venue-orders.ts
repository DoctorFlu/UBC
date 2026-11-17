import "server-only";

import type { Address, Hex } from "viem";

import type { Database } from "../db";

/** A stored, signed record (a venue order version or the executor's venue), document as raw JSON. */
export interface SignedRow {
  hash: Hex;
  document: unknown;
  signature: Hex;
  signer: Address;
  storedAt: string;
}

export interface VenueOrderRow extends SignedRow {
  intentId: number;
  revision: number;
}

interface OrderRow {
  intent_id: number;
  revision: number;
  hash: string;
  document: string;
  signature: string;
  signer: string;
  stored_at: string;
}

interface VenueRow {
  hash: string;
  document: string;
  signature: string;
  signer: string;
  stored_at: string;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fromOrderRow(row: OrderRow): VenueOrderRow {
  return {
    intentId: row.intent_id,
    revision: row.revision,
    hash: row.hash as Hex,
    document: parse(row.document),
    signature: row.signature as Hex,
    signer: row.signer as Address,
    storedAt: row.stored_at,
  };
}

/**
 * The executor's venue order journal (issue #93): the latest signed version of each intent's order, per
 * deployment, and the venue the executor last announced. The rules on what may replace what (a higher
 * revision, fixed fields unchanged, nothing after the order closed) are checked by the executor API
 * before `putOrder`; this store keeps exactly what it is given.
 */
export class VenueOrderStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  putOrder(
    deploymentId: string,
    record: {
      intentId: number;
      revision: number;
      hash: Hex;
      document: unknown;
      signature: Hex;
      signer: Address;
    },
  ): VenueOrderRow {
    this.db
      .prepare(
        `INSERT INTO venue_orders
           (deployment_id, intent_id, revision, hash, document, signature, signer, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (deployment_id, intent_id) DO UPDATE SET
           revision = excluded.revision, hash = excluded.hash, document = excluded.document,
           signature = excluded.signature, signer = excluded.signer, stored_at = excluded.stored_at`,
      )
      .run(
        deploymentId,
        record.intentId,
        record.revision,
        record.hash.toLowerCase(),
        JSON.stringify(record.document),
        record.signature.toLowerCase(),
        record.signer,
        this.now().toISOString(),
      );
    const row = this.order(deploymentId, record.intentId);
    if (!row) throw new Error(`venue order of intent ${String(record.intentId)} vanished after insert`);
    return row;
  }

  order(deploymentId: string, intentId: number): VenueOrderRow | null {
    const row = this.db
      .prepare("SELECT * FROM venue_orders WHERE deployment_id = ? AND intent_id = ?")
      .get(deploymentId, intentId) as OrderRow | undefined;
    return row ? fromOrderRow(row) : null;
  }

  orders(deploymentId: string): VenueOrderRow[] {
    const rows = this.db
      .prepare("SELECT * FROM venue_orders WHERE deployment_id = ? ORDER BY intent_id")
      .all(deploymentId) as unknown as OrderRow[];
    return rows.map(fromOrderRow);
  }

  putVenue(
    deploymentId: string,
    record: { hash: Hex; document: unknown; signature: Hex; signer: Address },
  ): SignedRow {
    this.db
      .prepare(
        `INSERT INTO executor_venues (deployment_id, hash, document, signature, signer, stored_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (deployment_id) DO UPDATE SET
           hash = excluded.hash, document = excluded.document, signature = excluded.signature,
           signer = excluded.signer, stored_at = excluded.stored_at`,
      )
      .run(
        deploymentId,
        record.hash.toLowerCase(),
        JSON.stringify(record.document),
        record.signature.toLowerCase(),
        record.signer,
        this.now().toISOString(),
      );
    const row = this.venue(deploymentId);
    if (!row) throw new Error("the executor's venue vanished after insert");
    return row;
  }

  venue(deploymentId: string): SignedRow | null {
    const row = this.db.prepare("SELECT * FROM executor_venues WHERE deployment_id = ?").get(deploymentId) as
      VenueRow | undefined;
    return row
      ? {
          hash: row.hash as Hex,
          document: parse(row.document),
          signature: row.signature as Hex,
          signer: row.signer as Address,
          storedAt: row.stored_at,
        }
      : null;
  }
}
