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

/** One announcement of the executor's venue, in the order the console stored them. */
export interface VenueAnnouncementRow extends SignedRow {
  /** 0 for the deployment's first announcement, then 1, 2, ... */
  seq: number;
  /**
   * The first block this announcement holds from: one past the head the console read when it stored it.
   * Null for an announcement stored before the console recorded blocks (migration 10).
   */
  holdsFromBlock: number | null;
}

interface VenueRow {
  seq: number;
  holds_from_block: number | null;
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

  /**
   * Appends an announcement to the deployment's history. It holds from `holdsFromBlock` on; the earlier
   * ones keep labelling the fills mined before it.
   */
  announceVenue(
    deploymentId: string,
    record: { hash: Hex; document: unknown; signature: Hex; signer: Address },
    holdsFromBlock: number,
  ): VenueAnnouncementRow {
    const latest = this.venue(deploymentId);
    this.db
      .prepare(
        `INSERT INTO executor_venue_announcements
           (deployment_id, seq, hash, document, signature, signer, stored_at, holds_from_block)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deploymentId,
        latest === null ? 0 : latest.seq + 1,
        record.hash.toLowerCase(),
        JSON.stringify(record.document),
        record.signature.toLowerCase(),
        record.signer,
        this.now().toISOString(),
        holdsFromBlock,
      );
    const row = this.venue(deploymentId);
    if (!row) throw new Error("the executor's venue vanished after insert");
    return row;
  }

  /** The announcement in force now: the latest stored. */
  venue(deploymentId: string): VenueAnnouncementRow | null {
    const row = this.db
      .prepare("SELECT * FROM executor_venue_announcements WHERE deployment_id = ? ORDER BY seq DESC LIMIT 1")
      .get(deploymentId) as VenueRow | undefined;
    return row ? fromVenueRow(row) : null;
  }

  /** Every announcement of the deployment, oldest first. */
  venues(deploymentId: string): VenueAnnouncementRow[] {
    const rows = this.db
      .prepare("SELECT * FROM executor_venue_announcements WHERE deployment_id = ? ORDER BY seq")
      .all(deploymentId) as unknown as VenueRow[];
    return rows.map(fromVenueRow);
  }
}

function fromVenueRow(row: VenueRow): VenueAnnouncementRow {
  return {
    seq: row.seq,
    holdsFromBlock: row.holds_from_block,
    hash: row.hash as Hex,
    document: parse(row.document),
    signature: row.signature as Hex,
    signer: row.signer as Address,
    storedAt: row.stored_at,
  };
}
