/**
 * Settled protection, as the owner reads it (issue #92): which ladders expired, what the contracts on each
 * cost, what they paid and the net, in plain words. Built from the verified settlement records only; a
 * record whose document no longer matches its hash is never counted.
 */
import { type Settlement, type SettlementTotals, settlementTotals } from "@mandate/shared";

import { formatUsdCents } from "@/lib/format";
import type { ChainView } from "@/lib/live/types";

/** One ladder's settled positions: one expiry of one asset. */
export interface SettledLadder {
  eventTicker: string;
  /** "BTC", read from the ticker; null when it does not start with one. */
  asset: string | null;
  expiresAt: string;
  /** The index level it settled on, as Gemini sent it; null when it sent none. */
  settlementValue: string | null;
  /** When the last of its outcomes was published. */
  resolvedAt: string;
  /** Highest strike first, then by intent id. */
  positions: Settlement[];
  totals: SettlementTotals;
}

/** The verified settlements of a chain view, by intent id. */
export function verifiedSettlements(chain: Pick<ChainView, "settlements"> | null): Map<number, Settlement> {
  const verified = new Map<number, Settlement>();
  for (const [id, view] of Object.entries(chain?.settlements ?? {})) {
    if (view.status === "verified") verified.set(Number(id), view.document);
  }
  return verified;
}

/** The asset of a crypto ladder ticker: "BTC2611202200" -> "BTC". */
export function tickerAsset(eventTicker: string): string | null {
  return /^([A-Z]+?)(?:05M|15M)?\d{10}$/.exec(eventTicker)?.[1] ?? null;
}

/** Settled ladders, newest expiry first, optionally of one asset only. */
export function settledLadders(
  chain: Pick<ChainView, "settlements"> | null,
  asset: string | null = null,
): SettledLadder[] {
  const byTicker = new Map<string, Settlement[]>();
  for (const doc of verifiedSettlements(chain).values()) {
    const list = byTicker.get(doc.eventTicker) ?? [];
    list.push(doc);
    byTicker.set(doc.eventTicker, list);
  }
  const ladders: SettledLadder[] = [];
  for (const [eventTicker, docs] of byTicker) {
    const ladderAsset = tickerAsset(eventTicker);
    if (asset !== null && ladderAsset !== asset) continue;
    const positions = [...docs].sort(
      (a, b) => (b.strikeCents ?? 0) - (a.strikeCents ?? 0) || a.intentId - b.intentId,
    );
    const latest = (field: "expiresAt" | "resolvedAt") =>
      positions.map((doc) => doc[field]).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    ladders.push({
      eventTicker,
      asset: ladderAsset,
      expiresAt: latest("expiresAt"),
      settlementValue: positions.find((doc) => doc.settlementValue !== null)?.settlementValue ?? null,
      resolvedAt: latest("resolvedAt"),
      positions,
      totals: settlementTotals(positions),
    });
  }
  return ladders.sort(
    (a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt) || a.eventTicker.localeCompare(b.eventTicker),
  );
}

const usd = (cents: number) => formatUsdCents(cents);

/** "$64,992.86" from Gemini's "64992.864": the level, in whole cents, rounded half up. */
export function formatSettlementValue(value: string | null): string | null {
  if (value === null || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  let cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  if (Number(fraction.charAt(2) || "0") >= 5) cents += 1n;
  return formatUsdCents(cents);
}

/** What the protection cost, what it paid and the net, in one plain sentence. */
export function totalsSentence(totals: SettlementTotals): string {
  const { costCents, payoutCents, pnlCents } = totals;
  if (payoutCents === 0)
    return `It cost ${usd(costCents)} and paid nothing, so the protection cost ${usd(costCents)}.`;
  const net =
    pnlCents > 0
      ? `a net gain of ${usd(pnlCents)}`
      : pnlCents < 0
        ? `a net cost of ${usd(-pnlCents)}`
        : "exactly what it cost";
  return `It cost ${usd(costCents)} and paid ${usd(payoutCents)}: ${net}.`;
}

/** "BTC settled at $64,992.86, so 2 of the 3 positions paid out." for the headline of a settled ladder. */
export function settledAtSentence(ladder: SettledLadder): string {
  const level = formatSettlementValue(ladder.settlementValue);
  const asset = ladder.asset ?? "The market";
  const count = ladder.positions.length;
  const paying = ladder.positions.filter((doc) => doc.payoutCents > 0).length;
  const where = level === null ? `${asset} settled` : `${asset} settled at ${level}`;
  if (count === 1) return `${where}, so the position ${paying === 1 ? "paid out" : "paid nothing"}.`;
  if (paying === 0) return `${where}, so none of the ${count.toString()} positions paid.`;
  if (paying === count) return `${where}, so all ${count.toString()} positions paid out.`;
  return `${where}, so ${paying.toString()} of the ${count.toString()} positions paid out.`;
}

/** Where a plan's ladder stands once it may have expired. */
export type LadderSettlementState =
  /** Not expired yet, or the clock is not known yet (server render). */
  | { state: "open" }
  /** Expired with nothing filled on it, so nothing settles. */
  | { state: "nothing_filled"; expiresAt: string }
  /** Expired; `waiting` filled positions still wait for Gemini's outcome, the rest are in `ladder`. */
  | { state: "settling"; expiresAt: string; waiting: number; ladder: SettledLadder | null }
  /** Every filled position on it has settled. */
  | { state: "settled"; expiresAt: string; ladder: SettledLadder };

/** The event ticker inside a Gemini instrument symbol: "GEMI-BTC2611202200-HI65000" -> "BTC2611202200". */
export function symbolTicker(market: string | null): string | null {
  return market === null ? null : (/^GEMI-([A-Z0-9]+)-/.exec(market)?.[1] ?? null);
}

/**
 * Whether the ladder a plan is on has expired and how far its settlement has come. A stored settlement
 * proves expiry without a clock; otherwise `now` decides, and null (no clock yet) reads as open.
 */
export function ladderSettlement(
  chain: Pick<ChainView, "settlements" | "intents"> | null,
  ladder: { eventTicker: string; expiry: string },
  now: number | null,
): LadderSettlementState {
  const settled = settledLadders(chain).find((candidate) => candidate.eventTicker === ladder.eventTicker);
  const expired = settled !== undefined || (now !== null && Date.parse(ladder.expiry) <= now);
  if (!expired) return { state: "open" };
  const settledIds = new Set(settled?.positions.map((position) => position.intentId));
  const filled = (chain?.intents ?? []).filter(
    (intent) =>
      intent.status === "executed" &&
      intent.isBuy === true &&
      (intent.filledCents ?? 0) > 0 &&
      symbolTicker(intent.market) === ladder.eventTicker,
  );
  const waiting = filled.filter((intent) => !settledIds.has(intent.id)).length;
  if (settled === undefined && filled.length === 0) {
    return { state: "nothing_filled", expiresAt: ladder.expiry };
  }
  if (settled !== undefined && waiting === 0) {
    return { state: "settled", expiresAt: ladder.expiry, ladder: settled };
  }
  return { state: "settling", expiresAt: ladder.expiry, waiting, ladder: settled ?? null };
}
