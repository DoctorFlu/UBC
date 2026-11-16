/**
 * Which intents a payment paid for. The only link the console trusts is the agent's sealed reason: a
 * decision context whose hash checks out and whose `signalReceiptIds` names the payment's receipt id.
 */
import type { IntentView } from "@mandate/shared";

import type { ChainView } from "@/lib/live/types";

import type { SignalBudgetView } from "./types";
import { parseUsdcAtomic } from "./usdc";

/** The anchor of a payment's row on the payments page, so other views can link to it. */
export function paymentAnchor(receiptId: string): string {
  return `payment-${receiptId.toLowerCase()}`;
}

export function paymentHref(receiptId: string): string {
  return `/payments#${paymentAnchor(receiptId)}`;
}

/** Intents citing each receipt id (lower case), oldest first, from verified sealed reasons only. */
export function intentsByReceipt(
  chain: Pick<ChainView, "intents" | "sealed"> | null,
): Map<string, IntentView[]> {
  const byReceipt = new Map<string, IntentView[]>();
  for (const intent of chain?.intents ?? []) {
    const sealed = chain?.sealed[intent.id];
    if (sealed?.status !== "verified") continue;
    for (const receipt of new Set(sealed.document.signalReceiptIds.map((id) => id.toLowerCase()))) {
      byReceipt.set(receipt, [...(byReceipt.get(receipt) ?? []), intent]);
    }
  }
  return byReceipt;
}

export interface BudgetReading {
  spent: bigint;
  daily: bigint;
  maxPerPurchase: bigint;
  /** True when the snapshot's day is over: its spend no longer counts and the reading shows 0. */
  reset: boolean;
}

/** Whether the snapshot's day is over at `now`. */
export function budgetHasReset(budget: Pick<SignalBudgetView, "resetsAt">, now: number): boolean {
  return now >= Date.parse(budget.resetsAt);
}

/**
 * Today's spend against the daily budget. After `resetsAt` the snapshot's `spentToday` belongs to a day
 * that is over, so it reads 0 until the agent sends the new day's snapshot.
 */
export function budgetReading(budget: SignalBudgetView, reset: boolean): BudgetReading {
  return {
    spent: reset ? 0n : parseUsdcAtomic(budget.spentToday),
    daily: parseUsdcAtomic(budget.dailyBudget),
    maxPerPurchase: parseUsdcAtomic(budget.maxPricePerPurchase),
    reset,
  };
}
