import * as z from "zod";
import {
  categoryLabel,
  INTENT_STATUS_LABELS,
  INTENT_STATUSES,
  type Intent,
  type IntentView,
} from "@mandate/shared";
import type { IntentRecord } from "../state/ledger";
import { isoFromUnix } from "./format";
import { reasonCode } from "./rules";

export const IntentRowSchema = z.object({
  id: z.int(),
  market: z.string(),
  category: z.string(),
  outcome: z.string(),
  side: z.enum(["buy", "sell"]),
  amountCents: z.int(),
  limitPrice: z.int(),
  status: z.enum(INTENT_STATUSES).describe("approved, needs_approval, rejected, executed or failed"),
  statusLabel: z.string(),
  reason: z.string().nullable().describe("The contract's rejection reason, when rejected and known"),
  reasonCode: z.string().nullable(),
  proposedAt: z.string(),
  filledCents: z.int().nullable().describe("Amount filled, once the executor recorded a result"),
  pnlCents: z.int().nullable(),
  contextHash: z.string().nullable().describe("Hash of the sealed decision context, when known"),
});
export type IntentRow = z.infer<typeof IntentRowSchema>;

/** One intent, merged from storage (authoritative), the event log (reason) and this server's memory (context). */
export function intentRow(
  intent: Intent,
  view: IntentView | undefined,
  record: IntentRecord | undefined,
): IntentRow {
  const hasResult = intent.status === "executed" || intent.status === "failed";
  const rejectionReason = intent.status === "rejected" ? (view?.reason ?? null) : null;
  return {
    id: intent.id,
    market: intent.market,
    category: categoryLabel(intent.category),
    outcome: intent.outcome,
    side: intent.isBuy ? "buy" : "sell",
    amountCents: intent.amountCents,
    limitPrice: intent.limitPrice,
    status: intent.status,
    statusLabel: INTENT_STATUS_LABELS[intent.status],
    reason: rejectionReason,
    reasonCode: rejectionReason === null ? null : reasonCode(rejectionReason),
    proposedAt: isoFromUnix(intent.proposedAt),
    filledCents: hasResult ? intent.filledCents : null,
    pnlCents: hasResult ? intent.pnlCents : null,
    contextHash: record?.contextHash ?? nonZero(view?.contextHash ?? null),
  };
}

function nonZero(hash: `0x${string}` | null): `0x${string}` | null {
  return hash === null || /^0x0+$/.test(hash) ? null : hash;
}
