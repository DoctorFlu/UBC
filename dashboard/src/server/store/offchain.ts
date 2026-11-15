import "server-only";

import { randomUUID } from "node:crypto";

import {
  type ConsoleHolding,
  type PolicyChangeRequest,
  type PostPlanRequest,
  type PostPolicyChangeRequest,
  type ProposedRules,
  type PutPairingRequest,
  holdingSchema,
  proposedRulesSchema,
} from "@mandate/shared";
import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { z } from "zod";

import { type Database, transaction } from "../db";

/** A decision context exactly as stored. The document is raw JSON so a read can detect tampering. */
export interface StoredContext {
  hash: Hex;
  document: unknown;
  storedAt: string;
}

export interface StoredPlan {
  planId: string;
  asset: string;
  requestText: string;
  createdAt: string;
  plan: Record<string, unknown>;
  storedAt: string;
}

export interface StoredIntentContextLink {
  intentId: number;
  hash: Hex;
  txHash: Hex;
  linkedAt: string;
}

export type LinkResult =
  | { ok: true; link: StoredIntentContextLink; created: boolean }
  | { ok: false; existing: StoredIntentContextLink };

interface LinkRow {
  intent_id: number;
  hash: Hex;
  tx_hash: Hex;
  linked_at: string;
}

function linkFromRow(row: LinkRow): StoredIntentContextLink {
  return { intentId: row.intent_id, hash: row.hash, txHash: row.tx_hash, linkedAt: row.linked_at };
}

export type PairingStatus = "pending" | "confirmed";

export interface StoredPairing {
  agentAddress: Address;
  agentName: string;
  serverVersion: string;
  status: PairingStatus;
  announcedAt: string;
  confirmedAt: string | null;
  confirmedBy: Address | null;
}

export interface StoredHoldings {
  holdings: ConsoleHolding[];
  updatedAt: string | null;
}

const holdingsSchema = z.array(holdingSchema);

/**
 * The records the console is the system of record for. Nothing here is onchain and nothing here can
 * change the mandate: change requests only become rules when the owner signs `setPolicy`.
 */
export class OffchainStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- holdings

  holdings(): StoredHoldings {
    const row = this.db.prepare("SELECT payload, updated_at FROM holdings WHERE id = 1").get() as
      { payload: string; updated_at: string } | undefined;
    if (!row) return { holdings: [], updatedAt: null };
    return { holdings: holdingsSchema.parse(JSON.parse(row.payload)), updatedAt: row.updated_at };
  }

  saveHoldings(holdings: readonly ConsoleHolding[]): StoredHoldings {
    const valid = holdingsSchema.parse(holdings);
    const updatedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO holdings (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(valid), updatedAt);
    return { holdings: valid, updatedAt };
  }

  // ---------------------------------------------------------------- decision contexts

  /** Stores a context under its hash. A hash stored before keeps its first document and time. */
  putContext(hash: Hex, document: unknown): { context: StoredContext; created: boolean } {
    const key = hash.toLowerCase() as Hex;
    const storedAt = this.now().toISOString();
    const result = this.db
      .prepare("INSERT OR IGNORE INTO decision_contexts (hash, document, stored_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(document), storedAt);
    const context = this.context(key);
    if (!context) throw new Error(`decision context ${key} vanished after insert`);
    return { context, created: Number(result.changes) > 0 };
  }

  context(hash: string): StoredContext | null {
    const row = this.db
      .prepare("SELECT hash, document, stored_at FROM decision_contexts WHERE hash = ?")
      .get(hash.toLowerCase()) as { hash: Hex; document: string; stored_at: string } | undefined;
    if (!row) return null;
    let document: unknown;
    try {
      document = JSON.parse(row.document);
    } catch {
      document = row.document;
    }
    return { hash: row.hash, document, storedAt: row.stored_at };
  }

  contexts(hashes: Iterable<string>): Map<string, StoredContext> {
    const found = new Map<string, StoredContext>();
    for (const hash of new Set([...hashes].map((value) => value.toLowerCase()))) {
      const context = this.context(hash);
      if (context) found.set(hash, context);
    }
    return found;
  }

  // ---------------------------------------------------------------- intent to context links

  /**
   * Links an intent of one deployment to its decision-context hash. The same link again is a no-op;
   * a different hash for a linked intent is refused, so a link can never be rewritten after the fact.
   */
  linkIntentContext(deploymentId: string, intentId: number, hash: Hex, txHash: Hex): LinkResult {
    const key = hash.toLowerCase() as Hex;
    const tx = txHash.toLowerCase() as Hex;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO intent_context_links (deployment_id, intent_id, hash, tx_hash, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(deploymentId, intentId, key, tx, this.now().toISOString());
    const link = this.intentContextLink(deploymentId, intentId);
    if (!link) throw new Error(`intent context link ${String(intentId)} vanished after insert`);
    if (link.hash !== key || link.txHash !== tx) return { ok: false, existing: link };
    return { ok: true, link, created: Number(result.changes) > 0 };
  }

  intentContextLink(deploymentId: string, intentId: number): StoredIntentContextLink | null {
    const row = this.db
      .prepare("SELECT * FROM intent_context_links WHERE deployment_id = ? AND intent_id = ?")
      .get(deploymentId, intentId) as LinkRow | undefined;
    return row ? linkFromRow(row) : null;
  }

  intentContextLinks(deploymentId: string): Map<number, StoredIntentContextLink> {
    const rows = this.db
      .prepare("SELECT * FROM intent_context_links WHERE deployment_id = ?")
      .all(deploymentId) as unknown as LinkRow[];
    return new Map(rows.map((row) => [row.intent_id, linkFromRow(row)]));
  }

  // ---------------------------------------------------------------- hedge plans

  /** Stores a plan. Posting the same `planId` again replaces nothing and returns the stored record. */
  putPlan(input: PostPlanRequest): { plan: StoredPlan; created: boolean } {
    const storedAt = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO hedge_plans (plan_id, asset, request_text, created_at, plan, stored_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.planId,
        input.asset,
        input.requestText,
        input.createdAt,
        JSON.stringify(input.plan),
        storedAt,
      );
    const plan = this.plan(input.planId);
    if (!plan) throw new Error(`plan ${input.planId} vanished after insert`);
    return { plan, created: Number(result.changes) > 0 };
  }

  plan(planId: string): StoredPlan | null {
    const row = this.db.prepare("SELECT * FROM hedge_plans WHERE plan_id = ?").get(planId) as
      PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  latestPlan(): StoredPlan | null {
    const row = this.db
      .prepare("SELECT * FROM hedge_plans ORDER BY stored_at DESC, rowid DESC LIMIT 1")
      .get() as PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  // ---------------------------------------------------------------- policy change requests

  createChangeRequest(input: PostPolicyChangeRequest): PolicyChangeRequest {
    const request: PolicyChangeRequest = {
      id: `pcr_${randomUUID()}`,
      agentAddress: getAddress(input.agentAddress),
      proposed: input.proposed,
      reason: input.reason,
      status: "pending",
      createdAt: this.now().toISOString(),
      resolvedAt: null,
      appliedTxHash: null,
    };
    this.db
      .prepare(
        `INSERT INTO policy_change_requests
           (id, agent_address, proposed, reason, status, created_at, resolved_at, applied_tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        request.id,
        request.agentAddress,
        JSON.stringify(request.proposed),
        request.reason,
        request.status,
        request.createdAt,
      );
    return request;
  }

  changeRequest(id: string): PolicyChangeRequest | null {
    const row = this.db.prepare("SELECT * FROM policy_change_requests WHERE id = ?").get(id) as
      ChangeRequestRow | undefined;
    return row ? changeRequestFromRow(row) : null;
  }

  /** Newest first. */
  changeRequests(): PolicyChangeRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM policy_change_requests ORDER BY created_at DESC, rowid DESC")
      .all() as unknown as ChangeRequestRow[];
    return rows.map(changeRequestFromRow);
  }

  /**
   * Closes a pending request. Returns the updated request, or null when it does not exist. A request that
   * is already closed is returned unchanged.
   */
  resolveChangeRequest(
    id: string,
    resolution: { status: "dismissed" } | { status: "applied"; txHash: Hex },
  ): PolicyChangeRequest | null {
    return transaction(this.db, () => {
      const existing = this.changeRequest(id);
      if (!existing || existing.status !== "pending") return existing;
      this.db
        .prepare(
          "UPDATE policy_change_requests SET status = ?, resolved_at = ?, applied_tx_hash = ? WHERE id = ?",
        )
        .run(
          resolution.status,
          this.now().toISOString(),
          resolution.status === "applied" ? resolution.txHash : null,
          id,
        );
      return this.changeRequest(id);
    });
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Records that an agent announced itself. Idempotent: announcing again refreshes the name and version and
   * keeps a confirmation the owner already gave.
   */
  announce(input: PutPairingRequest): StoredPairing {
    const address = getAddress(input.agentAddress);
    this.db
      .prepare(
        `INSERT INTO pairings (agent_address, agent_name, server_version, status, announced_at)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT (agent_address) DO UPDATE SET
           agent_name = excluded.agent_name,
           server_version = excluded.server_version,
           announced_at = excluded.announced_at`,
      )
      .run(address, input.agentName, input.serverVersion, this.now().toISOString());
    const pairing = this.pairing(address);
    if (!pairing) throw new Error(`pairing ${address} vanished after insert`);
    return pairing;
  }

  pairing(agentAddress: string): StoredPairing | null {
    const row = this.db
      .prepare("SELECT * FROM pairings WHERE agent_address = ?")
      .get(getAddress(agentAddress)) as PairingRow | undefined;
    return row ? pairingFromRow(row) : null;
  }

  /** The agent that announced itself most recently, or null when none has. */
  latestPairing(): StoredPairing | null {
    const row = this.db
      .prepare("SELECT * FROM pairings ORDER BY announced_at DESC, rowid DESC LIMIT 1")
      .get() as PairingRow | undefined;
    return row ? pairingFromRow(row) : null;
  }

  /** Marks an announced agent as claimed by the owner. Returns null when it never announced itself. */
  confirmPairing(agentAddress: string, owner: Address): StoredPairing | null {
    const address = getAddress(agentAddress);
    this.db
      .prepare(
        `UPDATE pairings SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?
         WHERE agent_address = ? AND status = 'pending'`,
      )
      .run(this.now().toISOString(), getAddress(owner), address);
    return this.pairing(address);
  }
}

// ------------------------------------------------------------------ rows

interface PlanRow {
  plan_id: string;
  asset: string;
  request_text: string;
  created_at: string;
  plan: string;
  stored_at: string;
}

function planFromRow(row: PlanRow): StoredPlan {
  return {
    planId: row.plan_id,
    asset: row.asset,
    requestText: row.request_text,
    createdAt: row.created_at,
    plan: z.record(z.string(), z.unknown()).parse(JSON.parse(row.plan)),
    storedAt: row.stored_at,
  };
}

interface ChangeRequestRow {
  id: string;
  agent_address: string;
  proposed: string;
  reason: string;
  status: PolicyChangeRequest["status"];
  created_at: string;
  resolved_at: string | null;
  applied_tx_hash: string | null;
}

function changeRequestFromRow(row: ChangeRequestRow): PolicyChangeRequest {
  const proposed: ProposedRules = proposedRulesSchema.parse(JSON.parse(row.proposed));
  return {
    id: row.id,
    agentAddress: getAddress(row.agent_address),
    proposed,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    appliedTxHash: row.applied_tx_hash as Hex | null,
  };
}

interface PairingRow {
  agent_address: string;
  agent_name: string;
  server_version: string;
  status: PairingStatus;
  announced_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

function pairingFromRow(row: PairingRow): StoredPairing {
  return {
    agentAddress: getAddress(row.agent_address),
    agentName: row.agent_name,
    serverVersion: row.server_version,
    status: row.status,
    announcedAt: row.announced_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by ? getAddress(row.confirmed_by) : null,
  };
}
