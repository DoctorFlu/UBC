import "server-only";

import { randomUUID } from "node:crypto";

import {
  type ConsoleHolding,
  type PolicyChangeRequest,
  type PostPlanRequest,
  type PostPolicyChangeRequest,
  type ProposedRules,
  type PutPairingRequest,
  type PutSignalBudgetRequest,
  type PutSignalPaymentRequest,
  holdingSchema,
  proposedRulesSchema,
  putSignalBudgetRequestSchema,
  putSignalPaymentRequestSchema,
  selectGoalPlans,
  ZERO_HASH,
} from "@mandate/shared";
import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { z } from "zod";

import type { SignalBudgetView, SignalPaymentView } from "@/lib/payments/types";

import { type Database, transaction } from "../db";

/**
 * How many of a mandate's newest plans goal selection reads. A plan proposed further back than this has
 * long expired: the agent stores at most one plan per run.
 */
const GOAL_PLANS_READ = 500;

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
 *
 * Every record belongs to one mandate, and every method takes the mandate first: a read never returns, and
 * a write never touches, another mandate's record, whatever id or hash the caller names.
 */
export class OffchainStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- holdings

  holdings(mandateId: string): StoredHoldings {
    const row = this.db
      .prepare("SELECT payload, updated_at FROM holdings WHERE mandate_id = ?")
      .get(mandateId) as { payload: string; updated_at: string } | undefined;
    if (!row) return { holdings: [], updatedAt: null };
    return { holdings: holdingsSchema.parse(JSON.parse(row.payload)), updatedAt: row.updated_at };
  }

  saveHoldings(mandateId: string, holdings: readonly ConsoleHolding[]): StoredHoldings {
    const valid = holdingsSchema.parse(holdings);
    const updatedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO holdings (mandate_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (mandate_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(mandateId, JSON.stringify(valid), updatedAt);
    return { holdings: valid, updatedAt };
  }

  // ---------------------------------------------------------------- decision contexts

  /** Stores a context under its hash. A hash stored before keeps its first document and time. */
  putContext(mandateId: string, hash: Hex, document: unknown): { context: StoredContext; created: boolean } {
    const key = hash.toLowerCase() as Hex;
    const storedAt = this.now().toISOString();
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO decision_contexts (mandate_id, hash, document, stored_at) VALUES (?, ?, ?, ?)",
      )
      .run(mandateId, key, JSON.stringify(document), storedAt);
    const context = this.context(mandateId, key);
    if (!context) throw new Error(`decision context ${key} vanished after insert`);
    return { context, created: Number(result.changes) > 0 };
  }

  context(mandateId: string, hash: string): StoredContext | null {
    const row = this.db
      .prepare("SELECT hash, document, stored_at FROM decision_contexts WHERE mandate_id = ? AND hash = ?")
      .get(mandateId, hash.toLowerCase()) as { hash: Hex; document: string; stored_at: string } | undefined;
    if (!row) return null;
    let document: unknown;
    try {
      document = JSON.parse(row.document);
    } catch {
      document = row.document;
    }
    return { hash: row.hash, document, storedAt: row.stored_at };
  }

  contexts(mandateId: string, hashes: Iterable<string>): Map<string, StoredContext> {
    const found = new Map<string, StoredContext>();
    for (const hash of new Set([...hashes].map((value) => value.toLowerCase()))) {
      const context = this.context(mandateId, hash);
      if (context) found.set(hash, context);
    }
    return found;
  }

  // ---------------------------------------------------------------- intent to context links

  /**
   * Links an intent of one deployment to its decision-context hash. The same link again is a no-op;
   * a different hash for a linked intent is refused, so a link can never be rewritten after the fact.
   */
  linkIntentContext(
    mandateId: string,
    deploymentId: string,
    intentId: number,
    hash: Hex,
    txHash: Hex,
  ): LinkResult {
    const key = hash.toLowerCase() as Hex;
    const tx = txHash.toLowerCase() as Hex;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO intent_context_links
           (mandate_id, deployment_id, intent_id, hash, tx_hash, linked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(mandateId, deploymentId, intentId, key, tx, this.now().toISOString());
    const link = this.intentContextLink(mandateId, deploymentId, intentId);
    if (!link) throw new Error(`intent context link ${String(intentId)} vanished after insert`);
    if (link.hash !== key || link.txHash !== tx) return { ok: false, existing: link };
    return { ok: true, link, created: Number(result.changes) > 0 };
  }

  intentContextLink(
    mandateId: string,
    deploymentId: string,
    intentId: number,
  ): StoredIntentContextLink | null {
    const row = this.db
      .prepare(
        "SELECT * FROM intent_context_links WHERE mandate_id = ? AND deployment_id = ? AND intent_id = ?",
      )
      .get(mandateId, deploymentId, intentId) as LinkRow | undefined;
    return row ? linkFromRow(row) : null;
  }

  intentContextLinks(mandateId: string, deploymentId: string): Map<number, StoredIntentContextLink> {
    const rows = this.db
      .prepare("SELECT * FROM intent_context_links WHERE mandate_id = ? AND deployment_id = ?")
      .all(mandateId, deploymentId) as unknown as LinkRow[];
    return new Map(rows.map((row) => [row.intent_id, linkFromRow(row)]));
  }

  // ---------------------------------------------------------------- hedge plans

  /** Stores a plan. Posting the same `planId` again replaces nothing and returns the stored record. */
  putPlan(mandateId: string, input: PostPlanRequest): { plan: StoredPlan; created: boolean } {
    const storedAt = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO hedge_plans
           (mandate_id, plan_id, asset, request_text, created_at, plan, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mandateId,
        input.planId,
        input.asset,
        input.requestText,
        input.createdAt,
        JSON.stringify(input.plan),
        storedAt,
      );
    const plan = this.plan(mandateId, input.planId);
    if (!plan) throw new Error(`plan ${input.planId} vanished after insert`);
    return { plan, created: Number(result.changes) > 0 };
  }

  plan(mandateId: string, planId: string): StoredPlan | null {
    const row = this.db
      .prepare("SELECT * FROM hedge_plans WHERE mandate_id = ? AND plan_id = ?")
      .get(mandateId, planId) as PlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  /**
   * The mandate's goal plans, newest first: one per (asset, event), by the rule in `selectGoalPlans`. The
   * newest plan of each asset, and every plan with an order proposed to the contract, are candidates. An
   * order counts when its intent is linked to a decision context naming the plan, on any of the mandate's
   * contracts, or when its `IntentProposed` event carried such a context's hash (`onchainHashes`), as a
   * contract that records the hash does.
   */
  goalPlans(mandateId: string, onchainHashes: Iterable<string | null> = []): StoredPlan[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hedge_plans WHERE mandate_id = ?
         ORDER BY stored_at DESC, rowid DESC LIMIT ${String(GOAL_PLANS_READ)}`,
      )
      .all(mandateId) as unknown as PlanRow[];
    const proposed = this.db
      .prepare(
        `SELECT DISTINCT json_extract(c.document, '$.planId') AS plan_id
         FROM intent_context_links AS l
         JOIN decision_contexts AS c ON c.mandate_id = l.mandate_id AND c.hash = l.hash
         WHERE l.mandate_id = ?`,
      )
      .all(mandateId) as unknown as { plan_id: unknown }[];
    const hashes = [...onchainHashes].filter(
      (hash): hash is string => hash !== null && hash.toLowerCase() !== ZERO_HASH,
    );
    const sealed = [...this.contexts(mandateId, hashes).values()].map((context) => ({
      plan_id: (context.document as { planId?: unknown }).planId,
    }));
    return selectGoalPlans(
      rows.map(planFromRow),
      (plan) => ({
        planId: plan.planId,
        asset: plan.asset,
        eventTicker: typeof plan.plan["eventTicker"] === "string" ? plan.plan["eventTicker"] : "",
      }),
      new Set(
        [...proposed, ...sealed].flatMap((row) => (typeof row.plan_id === "string" ? [row.plan_id] : [])),
      ),
    );
  }

  // ---------------------------------------------------------------- signal payments (#22)

  /**
   * Records one payment under its receipt id (lower case). A payment is an immutable fact: a repeat
   * stores nothing and returns the first record, whatever its body says.
   */
  putSignalPayment(
    mandateId: string,
    receiptId: string,
    payment: PutSignalPaymentRequest,
  ): { payment: SignalPaymentView; created: boolean } {
    const id = receiptId.toLowerCase();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO signal_payments (mandate_id, receipt_id, paid_at, payment, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        mandateId,
        id,
        new Date(payment.paidAt).toISOString(),
        JSON.stringify(payment),
        this.now().toISOString(),
      );
    const stored = this.signalPayment(mandateId, id);
    if (!stored) throw new Error(`payment ${id} vanished after insert`);
    return { payment: stored, created: Number(result.changes) > 0 };
  }

  signalPayment(mandateId: string, receiptId: string): SignalPaymentView | null {
    const row = this.db
      .prepare("SELECT * FROM signal_payments WHERE mandate_id = ? AND receipt_id = ?")
      .get(mandateId, receiptId.toLowerCase()) as PaymentRow | undefined;
    return row ? paymentFromRow(row) : null;
  }

  /** Newest payment first. */
  signalPayments(mandateId: string, limit = 500): SignalPaymentView[] {
    const rows = this.db
      .prepare("SELECT * FROM signal_payments WHERE mandate_id = ? ORDER BY paid_at DESC, rowid DESC LIMIT ?")
      .all(mandateId, limit) as unknown as PaymentRow[];
    return rows.map(paymentFromRow);
  }

  /** Keeps the snapshot with the latest `asOf`; an older one is ignored. Returns what is now stored. */
  putSignalBudget(mandateId: string, snapshot: PutSignalBudgetRequest): SignalBudgetView {
    const asOf = new Date(snapshot.asOf).toISOString();
    return transaction(this.db, () => {
      const current = this.signalBudget(mandateId);
      if (!current || Date.parse(current.asOf) < Date.parse(asOf)) {
        this.db
          .prepare(
            `INSERT INTO signal_budget (mandate_id, as_of, snapshot, stored_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (mandate_id) DO UPDATE SET as_of = excluded.as_of, snapshot = excluded.snapshot,
               stored_at = excluded.stored_at`,
          )
          .run(mandateId, asOf, JSON.stringify(snapshot), this.now().toISOString());
      }
      const stored = this.signalBudget(mandateId);
      if (!stored) throw new Error("the signal budget vanished after insert");
      return stored;
    });
  }

  signalBudget(mandateId: string): SignalBudgetView | null {
    const row = this.db.prepare("SELECT * FROM signal_budget WHERE mandate_id = ?").get(mandateId) as
      BudgetRow | undefined;
    return row
      ? { ...putSignalBudgetRequestSchema.parse(JSON.parse(row.snapshot)), storedAt: row.stored_at }
      : null;
  }

  // ---------------------------------------------------------------- policy change requests

  createChangeRequest(mandateId: string, input: PostPolicyChangeRequest): PolicyChangeRequest {
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
           (id, mandate_id, agent_address, proposed, reason, status, created_at, resolved_at, applied_tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        request.id,
        mandateId,
        request.agentAddress,
        JSON.stringify(request.proposed),
        request.reason,
        request.status,
        request.createdAt,
      );
    return request;
  }

  changeRequest(mandateId: string, id: string): PolicyChangeRequest | null {
    const row = this.db
      .prepare("SELECT * FROM policy_change_requests WHERE mandate_id = ? AND id = ?")
      .get(mandateId, id) as ChangeRequestRow | undefined;
    return row ? changeRequestFromRow(row) : null;
  }

  /** Newest first. */
  changeRequests(mandateId: string): PolicyChangeRequest[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM policy_change_requests WHERE mandate_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(mandateId) as unknown as ChangeRequestRow[];
    return rows.map(changeRequestFromRow);
  }

  /**
   * Closes a pending request. Returns the updated request, or null when it does not exist. A request that
   * is already closed is returned unchanged.
   */
  resolveChangeRequest(
    mandateId: string,
    id: string,
    resolution: { status: "dismissed" } | { status: "applied"; txHash: Hex },
  ): PolicyChangeRequest | null {
    return transaction(this.db, () => {
      const existing = this.changeRequest(mandateId, id);
      if (!existing || existing.status !== "pending") return existing;
      this.db
        .prepare(
          `UPDATE policy_change_requests SET status = ?, resolved_at = ?, applied_tx_hash = ?
           WHERE mandate_id = ? AND id = ?`,
        )
        .run(
          resolution.status,
          this.now().toISOString(),
          resolution.status === "applied" ? resolution.txHash : null,
          mandateId,
          id,
        );
      return this.changeRequest(mandateId, id);
    });
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Records that an agent announced itself. Idempotent: announcing again refreshes the name and version and
   * keeps a confirmation the owner already gave.
   */
  announce(mandateId: string, input: PutPairingRequest): StoredPairing {
    const address = getAddress(input.agentAddress);
    this.db
      .prepare(
        `INSERT INTO pairings (mandate_id, agent_address, agent_name, server_version, status, announced_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (mandate_id, agent_address) DO UPDATE SET
           agent_name = excluded.agent_name,
           server_version = excluded.server_version,
           announced_at = excluded.announced_at`,
      )
      .run(mandateId, address, input.agentName, input.serverVersion, this.now().toISOString());
    const pairing = this.pairing(mandateId, address);
    if (!pairing) throw new Error(`pairing ${address} vanished after insert`);
    return pairing;
  }

  pairing(mandateId: string, agentAddress: string): StoredPairing | null {
    const row = this.db
      .prepare("SELECT * FROM pairings WHERE mandate_id = ? AND agent_address = ?")
      .get(mandateId, getAddress(agentAddress)) as PairingRow | undefined;
    return row ? pairingFromRow(row) : null;
  }

  /** The agent that announced itself most recently, or null when none has. */
  latestPairing(mandateId: string): StoredPairing | null {
    const row = this.db
      .prepare("SELECT * FROM pairings WHERE mandate_id = ? ORDER BY announced_at DESC, rowid DESC LIMIT 1")
      .get(mandateId) as PairingRow | undefined;
    return row ? pairingFromRow(row) : null;
  }

  /** Marks an announced agent as claimed by the owner. Returns null when it never announced itself. */
  confirmPairing(mandateId: string, agentAddress: string, owner: Address): StoredPairing | null {
    const address = getAddress(agentAddress);
    this.db
      .prepare(
        `UPDATE pairings SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?
         WHERE mandate_id = ? AND agent_address = ? AND status = 'pending'`,
      )
      .run(this.now().toISOString(), getAddress(owner), mandateId, address);
    return this.pairing(mandateId, address);
  }
}

// ------------------------------------------------------------------ rows

interface PaymentRow {
  receipt_id: string;
  paid_at: string;
  payment: string;
  recorded_at: string;
}

function paymentFromRow(row: PaymentRow): SignalPaymentView {
  return {
    ...putSignalPaymentRequestSchema.parse(JSON.parse(row.payment)),
    receiptId: row.receipt_id,
    recordedAt: row.recorded_at,
  };
}

interface BudgetRow {
  as_of: string;
  snapshot: string;
  stored_at: string;
}

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
