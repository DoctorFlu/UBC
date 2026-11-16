/**
 * The audit trail: one row per Policy event, newest first, worded for the owner and for a CSV. Every row
 * is read from the contract's events; nothing here is stored or edited by the console.
 */
import {
  CATEGORY_LABELS,
  type PolicyEvent,
  type PolicyEventType,
  categoriesFromMask,
  describeReason,
  eventKey,
} from "@mandate/shared";
import type { Hex } from "viem";

import type { StatusKind } from "@/components/ui/StatusChip";
import { formatUsdCents, formatUsdCentsDelta } from "@/lib/format";
import { isoFromUnix } from "@/lib/live/derive";
import type { ChainView } from "@/lib/live/types";
import { describeMarket } from "@/lib/markets";

export interface AuditRow {
  id: string;
  at: string;
  blockNumber: number;
  event: PolicyEventType;
  intentId: number | null;
  summary: string;
  status: StatusKind | null;
  reason: string | null;
  txHash: Hex;
}

export const EVENT_LABELS: Record<PolicyEventType, string> = {
  PolicyUpdated: "Mandate set",
  Paused: "Kill switch",
  IntentProposed: "Intent proposed",
  IntentApproved: "Intent approved",
  IntentRejected: "Intent rejected",
  IntentNeedsApproval: "Held for approval",
  ResultRecorded: "Result recorded",
};

const usd = (cents: number) => formatUsdCents(cents, { trimWholeCents: true });

function order(event: { isBuy: boolean; outcome: string; market: string; amountCents: number }): string {
  return `${event.isBuy ? "Buy" : "Sell"} ${event.outcome} on ${describeMarket(event.market).title}, ${formatUsdCents(event.amountCents)}`;
}

function describe(event: PolicyEvent): Pick<AuditRow, "summary" | "status" | "reason" | "intentId"> {
  switch (event.type) {
    case "PolicyUpdated": {
      const { rules } = event;
      const markets = categoriesFromMask(rules.allowedCategories).map((id) => CATEGORY_LABELS[id]);
      return {
        summary: `Budget ${usd(rules.budgetCents)}, max trade ${usd(rules.maxTradeCents)}, approval above ${usd(rules.approvalAboveCents)}, daily loss ${usd(rules.dailyLossCents)}; markets: ${markets.join(", ") || "none"}`,
        status: rules.paused ? "paused" : null,
        reason: null,
        intentId: null,
      };
    }
    case "Paused":
      return {
        summary: event.paused
          ? "Paused: every new intent is rejected"
          : "Resumed: new intents are checked again",
        status: event.paused ? "paused" : null,
        reason: null,
        intentId: null,
      };
    case "IntentProposed":
      return { summary: order(event), status: null, reason: null, intentId: event.intentId };
    case "IntentApproved":
      return { summary: order(event), status: "approved", reason: null, intentId: event.intentId };
    case "IntentRejected":
      return {
        summary: describeReason(event.reason).explanation,
        status: "rejected",
        reason: event.reason,
        intentId: event.intentId,
      };
    case "IntentNeedsApproval":
      return {
        summary: `${formatUsdCents(event.amountCents)} is above the approval threshold: waiting for the owner`,
        status: "needs_approval",
        reason: null,
        intentId: event.intentId,
      };
    case "ResultRecorded":
      return {
        summary: event.filled
          ? `Filled ${formatUsdCents(event.filledCents)}, realized ${formatUsdCentsDelta(event.pnlCents)}`
          : "Did not fill",
        status: event.filled ? "executed" : "failed",
        reason: null,
        intentId: event.intentId,
      };
  }
}

export function auditRows(chain: ChainView): AuditRow[] {
  return [...chain.events].reverse().map((event) => ({
    id: eventKey(event),
    at: isoFromUnix(event.blockTimestamp),
    blockNumber: event.blockNumber,
    event: event.type,
    txHash: event.transactionHash,
    ...describe(event),
  }));
}
