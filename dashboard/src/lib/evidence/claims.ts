/**
 * What a stored decision context says about itself, read without trusting it. A context that no longer
 * hashes to the intent's sealed hash was changed after the fact, so nothing in it is evidence; the
 * console still reads which plan and receipts it names, so the plan it claims can show that its chain is
 * broken instead of quietly leaving the intent out.
 */
import type { SealedClaims } from "@/lib/live/types";

/** Longer than any plan id the agent API accepts (128): a longer value is not a plan id. */
const MAX_PLAN_ID = 128;
/** A receipt id is a 32-byte hex string; anything much longer is not one. */
const MAX_RECEIPT_ID = 80;
const MAX_RECEIPTS = 16;

export function readClaims(document: unknown): SealedClaims {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { planId: null, signalReceiptIds: [] };
  }
  const record = document as Record<string, unknown>;
  const planId =
    typeof record.planId === "string" && record.planId.length > 0 && record.planId.length <= MAX_PLAN_ID
      ? record.planId
      : null;
  const receipts = Array.isArray(record.signalReceiptIds) ? (record.signalReceiptIds as unknown[]) : [];
  return {
    planId,
    signalReceiptIds: receipts
      .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_RECEIPT_ID)
      .slice(0, MAX_RECEIPTS),
  };
}
