/**
 * The audit trail: one row per Policy event the console ingested, worded for the owner and for an
 * export. Every row is read from the contract's events; nothing here is stored or edited by the
 * console, so each one can be checked against its block and transaction.
 */
import {
  CATEGORY_LABELS,
  type PolicyEvent,
  type PolicyEventType,
  categoriesFromMask,
  describeReason,
  eventKey,
  intentAnomalies,
} from "@mandate/shared";
import type { Hex } from "viem";

import type { StatusKind } from "@/components/ui/StatusChip";
import { formatUsdCents, formatUsdCentsDelta } from "@/lib/format";
import { isoFromUnix } from "@/lib/live/derive";
import type { ChainView } from "@/lib/live/types";
import { describeMarket, namingCategory } from "@/lib/markets";

/**
 * What kind of decision a row records:
 * - `mandate`: the owner set or changed the rules (`PolicyUpdated`).
 * - `pause`: pausing and resuming trading (`Paused`).
 * - `verdict`: the contract's answer to a proposal, in the proposal's own transaction.
 * - `owner`: the owner approving or rejecting a held intent (`approveIntent`, `rejectIntent`).
 * - `result`: what the executor recorded (`ResultRecorded`).
 */
export type AuditGroup = "mandate" | "pause" | "roles" | "verdict" | "owner" | "result";

export interface AuditRow {
  id: string;
  /** ISO time of the block. */
  at: string;
  /** Unix seconds of the block, as the contract sees time. */
  blockTimestamp: number;
  blockNumber: number;
  logIndex: number;
  /** The contract's event name, exactly as emitted. */
  event: PolicyEventType;
  group: AuditGroup;
  /** The event in the owner's words, e.g. "Approved by owner". */
  label: string;
  intentId: number | null;
  summary: string;
  status: StatusKind | null;
  reason: string | null;
  /**
   * Why the MCP server could not have sent this row's intent ("outcome is not YES or NO"); empty for a
   * normal intent and for rows about no intent. Describes the onchain values, never quotes them.
   */
  flags: string[];
  txHash: Hex;
  /**
   * A `Paused` event that left the pause state as it was when its transaction began. `setPolicy` emits
   * one every time, after `PolicyUpdated`, so a rule change would otherwise read as "Resumed". The
   * screen leaves these out; the exports keep them, since they are raw contract events.
   */
  unchanged: boolean;
}

export const GROUP_LABELS: Record<AuditGroup, string> = {
  mandate: "Rule changes",
  pause: "Pauses",
  roles: "Role changes",
  verdict: "Proposal verdicts",
  owner: "Owner decisions",
  result: "Executor results",
};

export type AuditOrder = "newest" | "oldest";

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

/** A dollar amount, or a plain statement when the onchain value is too large for offchain code. */
function amount(cents: number | null): string {
  return cents === null ? "an amount too large to show" : formatUsdCents(cents);
}

/**
 * "Buy NO on BTC $65,000 or above, $12.40". Onchain text that is not a Gemini symbol or a YES/NO outcome
 * is described, never quoted: it was written by whoever held the agent key and lands in exports too.
 */
function order(
  event: {
    isBuy: boolean;
    outcome: string;
    market: string;
    amountCents: number | null;
  },
  category: number | null,
): string {
  const outcome =
    event.outcome === "YES" || event.outcome === "NO" ? event.outcome : "an outcome not YES or NO";
  return `${event.isBuy ? "Buy" : "Sell"} ${outcome} on ${describeMarket(event.market, category).title}, ${amount(event.amountCents)}`;
}

const ROLE_NAMES = {
  UserChanged: { label: "Owner", name: "owner (the contract's user)" },
  AgentChanged: { label: "Agent", name: "agent" },
  ExecutorChanged: { label: "Executor", name: "executor" },
} as const;

type Described = Pick<AuditRow, "group" | "label" | "summary" | "status" | "reason" | "intentId">;

/**
 * Describes one event. `held` is true when the intent was held for the owner in an earlier
 * transaction: its approval or rejection then records the owner's decision, not a verdict at proposal.
 * `version` is the mandate's version after a `PolicyUpdated`.
 */
function describe(
  event: PolicyEvent,
  held: boolean,
  version: number,
  categoryOf: ReadonlyMap<number, number | null>,
): Described {
  switch (event.type) {
    case "PolicyUpdated": {
      const { rules } = event;
      const markets = categoriesFromMask(rules.allowedCategories).map((id) => CATEGORY_LABELS[id]);
      return {
        group: "mandate",
        label: version === 1 ? "Rules set" : `Rules changed (v${version.toString()})`,
        summary: `Budget ${usd(rules.budgetCents)}, max trade ${usd(rules.maxTradeCents)}, approval above ${usd(rules.approvalAboveCents)}, daily loss ${usd(rules.dailyLossCents)}; markets: ${markets.join(", ") || "none"}`,
        status: rules.paused ? "paused" : null,
        reason: null,
        intentId: null,
      };
    }
    case "Paused":
      return {
        group: "pause",
        label: event.paused ? "Paused" : "Resumed",
        summary: event.paused ? "Every new intent is rejected" : "New intents are checked again",
        status: event.paused ? "paused" : null,
        reason: null,
        intentId: null,
      };
    case "UserChanged":
    case "AgentChanged":
    case "ExecutorChanged": {
      const role = ROLE_NAMES[event.type];
      const set = /^0x0{40}$/i.test(event.previous);
      return {
        group: "roles",
        label: set ? `${role.label} set` : `${role.label} changed`,
        summary: set
          ? `The ${role.name} is ${event.current}`
          : `The ${role.name} moved from ${event.previous} to ${event.current}`,
        status: null,
        reason: null,
        intentId: null,
      };
    }
    case "IntentProposed":
      return {
        group: "verdict",
        label: "Intent proposed",
        summary: order(event, categoryOf.get(event.intentId) ?? null),
        status: null,
        reason: null,
        intentId: event.intentId,
      };
    case "IntentApproved":
      return {
        group: held ? "owner" : "verdict",
        label: held ? "Approved by owner" : "Intent approved",
        summary: order(event, categoryOf.get(event.intentId) ?? null),
        status: "approved",
        reason: null,
        intentId: event.intentId,
      };
    case "IntentRejected": {
      const byOwner = event.reason === "rejected by user";
      return {
        group: held ? "owner" : "verdict",
        label: byOwner ? "Rejected by owner" : held ? "Rejected on approval" : "Intent rejected",
        summary: describeReason(event.reason).explanation,
        status: "rejected",
        reason: event.reason,
        intentId: event.intentId,
      };
    }
    case "IntentNeedsApproval":
      return {
        group: "verdict",
        label: "Held for approval",
        summary: `${amount(event.amountCents)} is above the approval threshold: waiting for the owner`,
        status: "needs_approval",
        reason: null,
        intentId: event.intentId,
      };
    case "ResultRecorded":
      return {
        group: "result",
        label: event.filled ? "Fill recorded" : "No fill recorded",
        summary: event.filled
          ? `The executor recorded a fill of ${amount(event.filledCents)} with a result at the fill of ${event.pnlCents === null ? "an amount too large to show" : formatUsdCentsDelta(event.pnlCents)}`
          : "The executor recorded that the order did not fill",
        status: event.filled ? "executed" : "failed",
        reason: null,
        intentId: event.intentId,
      };
  }
}

/** Every event as an audit row, oldest first (chain order). */
export function auditRows(chain: Pick<ChainView, "events" | "intents">): AuditRow[] {
  const flagsOf = new Map<number, string[]>();
  const categoryOf = new Map(chain.intents.map((intent) => [intent.id, namingCategory(intent)] as const));
  for (const intent of chain.intents) {
    const flags = intentAnomalies(intent).map((anomaly) => anomaly.text);
    if (flags.length > 0) flagsOf.set(intent.id, flags);
  }
  const heldIn = new Map<number, Hex>();
  let version = 0;
  let paused = false;
  let txHash: string | null = null;
  let pausedAtTxStart = false;
  return chain.events.map((event) => {
    const tx = event.transactionHash.toLowerCase();
    if (tx !== txHash) {
      txHash = tx;
      pausedAtTxStart = paused;
    }
    if (event.type === "PolicyUpdated") {
      version += 1;
      paused = event.rules.paused;
    } else if (event.type === "Paused") {
      paused = event.paused;
    }
    const intentId = "intentId" in event ? event.intentId : null;
    const heldTx = intentId === null ? undefined : heldIn.get(intentId);
    const held = heldTx !== undefined && heldTx.toLowerCase() !== event.transactionHash.toLowerCase();
    if (event.type === "IntentNeedsApproval") heldIn.set(event.intentId, event.transactionHash);
    const flags = intentId === null ? [] : (flagsOf.get(intentId) ?? []);
    const described = describe(event, held, version, categoryOf);
    return {
      id: eventKey(event),
      at: isoFromUnix(event.blockTimestamp),
      blockTimestamp: event.blockTimestamp,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      event: event.type,
      txHash: event.transactionHash,
      unchanged: event.type === "Paused" && event.paused === pausedAtTxStart,
      flags,
      ...described,
      summary:
        event.type === "ResultRecorded" && !event.filled && flags.length > 0
          ? "The executor recorded that the order did not fill: it refuses intents the MCP server could not have sent"
          : described.summary,
    };
  });
}

/** The rows the audit table shows: every row but the `Paused` events that changed nothing. */
export function onScreen(rows: readonly AuditRow[]): AuditRow[] {
  return rows.filter((row) => !row.unchanged);
}

/** The rows a filter and an order show, in the order shown. */
export function visibleRows(
  rows: readonly AuditRow[],
  group: AuditGroup | "all",
  sort: AuditOrder,
): AuditRow[] {
  const kept = group === "all" ? [...rows] : rows.filter((row) => row.group === group);
  return sort === "newest" ? kept.reverse() : kept;
}

/** Rejections by the contract's reason string, most frequent first. */
export function blockedByRule(rows: readonly AuditRow[]): [reason: string, count: number][] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.event === "IntentRejected" && row.reason !== null) {
      counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ------------------------------------------------------------------ export

const EXPORT_COLUMNS = [
  "time_utc",
  "block_timestamp",
  "block",
  "log_index",
  "event",
  "label",
  "intent",
  "status",
  "reason",
  "flags",
  "summary",
  "tx_hash",
  "explorer_url",
] as const;

export type AuditExportRecord = Record<(typeof EXPORT_COLUMNS)[number], string | number | null>;

export function exportRecord(row: AuditRow, explorerUrl: string | null): AuditExportRecord {
  return {
    time_utc: row.at,
    block_timestamp: row.blockTimestamp,
    block: row.blockNumber,
    log_index: row.logIndex,
    event: row.event,
    label: row.label,
    intent: row.intentId,
    status: row.status,
    reason: row.reason,
    flags: row.flags.length === 0 ? null : row.flags.join("; "),
    summary: row.summary,
    tx_hash: row.txHash,
    explorer_url: explorerUrl ? `${explorerUrl}/tx/${row.txHash}` : null,
  };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV of exactly these rows, in this order, with a header line. */
export function toCsv(rows: readonly AuditRow[], explorerUrl: string | null): string {
  const lines = rows.map((row) => {
    const record = exportRecord(row, explorerUrl);
    return EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(",");
  });
  return `${[EXPORT_COLUMNS.join(","), ...lines].join("\r\n")}\r\n`;
}

export interface AuditExportMeta {
  contract: string;
  chainId: number;
  network: string;
  filter: AuditGroup | "all";
  order: AuditOrder;
  exportedAt: string;
}

/** The same rows as JSON, with what they were read from and how they were filtered. */
export function toJson(rows: readonly AuditRow[], explorerUrl: string | null, meta: AuditExportMeta): string {
  return `${JSON.stringify({ ...meta, rows: rows.map((row) => exportRecord(row, explorerUrl)) }, null, 2)}\n`;
}
