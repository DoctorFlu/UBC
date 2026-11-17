import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { MAX_MARKET_SYMBOL_LENGTH, isMarketSymbol } from "./anomalies";
import { canonicalJson } from "./context";
import { addressSchema, bytes32Schema, intentIdSchema, outcomeSchema } from "./types";

/**
 * Settlement: what a filled position paid when its market resolved.
 *
 * The Policy contract cannot hold this. `recordResult` accepts one call per intent, while it is
 * `Approved`, and the executor makes that call when the order fills, days before the market resolves.
 * So the executor records the outcome offchain instead: it builds this document from the fill onchain
 * and the venue's published outcome, signs `hashSettlement(document)` with the executor key (EIP-191,
 * the raw 32 bytes), and stores both in the console. Anyone holding the document can check the hash,
 * and that the signer is the contract's `executor()`, the only account that may record results onchain.
 *
 * Like a decision context, every number is an integer (money in cents, quantities in hundredths of a
 * contract) and unknown keys are rejected, so the canonical JSON is identical in any language.
 */

const isoDateTime = z.iso.datetime({ offset: true });

/** Venues an executor fills orders on. `simulated` places nothing and reads Gemini's public outcomes. */
export const SETTLEMENT_VENUES = ["simulated", "gemini"] as const;
export type SettlementVenue = (typeof SETTLEMENT_VENUES)[number];

/** Gemini's `resolutionSide`: the side whose contracts paid $1 each. */
export const resolutionSchema = z.enum(["yes", "no"]);
export type Resolution = z.infer<typeof resolutionSchema>;

export const settlementSchema = z.strictObject({
  version: z.literal(1),
  /** The chain and the Policy contract the intent lives on. The address is in lower case. */
  chainId: z.int().positive(),
  policy: addressSchema.refine((value) => value === value.toLowerCase(), "policy must be lower case"),
  intentId: intentIdSchema,
  /** The intent's market, a Gemini `instrumentSymbol`. */
  market: z.string().max(MAX_MARKET_SYMBOL_LENGTH).refine(isMarketSymbol, "not a Gemini symbol"),
  /** The event (ladder) the market belongs to, as the venue named it. */
  eventTicker: z.string().min(1).max(MAX_MARKET_SYMBOL_LENGTH),
  /** The strike in cents for a ladder rung ("at or above"), null for any other market. */
  strikeCents: z.int().positive().nullable(),
  /** When the market stopped trading, as the venue published it. */
  expiresAt: isoDateTime,
  outcome: outcomeSchema,
  /** What the position cost: the `filledCents` the executor recorded onchain. */
  costCents: z.int().positive(),
  /** The intent's limit price, cents per $1 contract. */
  limitPrice: z.int().min(1).max(99),
  /** Contracts held, in hundredths. Each hundredth pays one cent when the outcome wins. */
  contractsHundredths: z.int().nonnegative(),
  resolution: resolutionSchema,
  /** What the position paid at settlement. */
  payoutCents: z.int().nonnegative(),
  /**
   * The venue's fee on the fill, estimated from its published schedule (no venue answer reports it), as
   * the order's journal recorded it. Absent when the venue charged none: the simulated venue trades nowhere.
   * Settlement itself is free on Gemini (a payout carried no fee on the sandbox).
   */
  feeCents: z.int().nonnegative().optional(),
  /** The net after fees: `payoutCents - costCents - feeCents`. */
  pnlCents: z.int(),
  /** The index level the market settled on, exactly as the venue sent it, when it sent one. */
  settlementValue: z.string().max(64).nullable(),
  /** When the venue published the outcome. */
  resolvedAt: isoDateTime,
  venue: z.enum(SETTLEMENT_VENUES),
});
export type Settlement = z.infer<typeof settlementSchema>;

/** An EIP-191 signature: 65 bytes as hex. */
export const signatureSchema = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value),
  { message: "not a 65-byte hex signature" },
);

/**
 * The contracts a fill bought, the same rule `@mandate/planner` counts cover with: the most the money
 * buys at the limit price, in whole hundredths of a contract.
 */
export function contractsBought(costCents: number, limitPrice: number): number {
  return Math.floor((costCents * 100) / limitPrice);
}

/** What `contractsHundredths` of `outcome` pay when the market resolved to `resolution`. */
export function payoutFor(
  outcome: "YES" | "NO",
  resolution: Resolution,
  contractsHundredths: number,
): number {
  return outcome.toLowerCase() === resolution ? contractsHundredths : 0;
}

/**
 * Why a settlement does not add up, or [] when it does: the net must be payout minus cost and fee, the payout
 * must be what the contracts held pay on that resolution, and on the simulated venue the contracts must
 * be what the cost buys at the limit price (a real venue reports what it actually filled).
 */
export function settlementProblems(doc: Settlement): string[] {
  const problems: string[] = [];
  if (doc.pnlCents !== doc.payoutCents - doc.costCents - (doc.feeCents ?? 0))
    problems.push("pnlCents is not payoutCents - costCents - feeCents");
  if (doc.venue === "simulated" && doc.feeCents !== undefined) {
    problems.push("the simulated venue charges no fee");
  }
  if (doc.payoutCents !== payoutFor(doc.outcome, doc.resolution, doc.contractsHundredths)) {
    problems.push("payoutCents is not what the contracts pay on this resolution");
  }
  if (
    doc.venue === "simulated" &&
    doc.contractsHundredths !== contractsBought(doc.costCents, doc.limitPrice)
  ) {
    problems.push("contractsHundredths is not what costCents buys at limitPrice");
  }
  return problems;
}

/** Validates the document and returns keccak256 of its canonical JSON (UTF-8). */
export function hashSettlement(doc: Settlement): Hex {
  const valid = settlementSchema.parse(doc);
  return keccak256(stringToBytes(canonicalJson(valid)));
}

/** True when `doc` is a valid settlement whose hash equals `hash`. Never throws. */
export function verifySettlementHash(doc: unknown, hash: string): boolean {
  const parsedDoc = settlementSchema.safeParse(doc);
  const parsedHash = bytes32Schema.safeParse(hash);
  if (!parsedDoc.success || !parsedHash.success) return false;
  return hashSettlement(parsedDoc.data).toLowerCase() === parsedHash.data.toLowerCase();
}

/** What the executor signs: the hash's 32 raw bytes, as an EIP-191 personal message. */
export function settlementMessage(hash: Hex): { raw: Hex } {
  return { raw: hash };
}

/** The money side of a set of settlements, for a sentence: cost, estimated fees, payout and the net after fees. */
export interface SettlementTotals {
  positions: number;
  costCents: number;
  /** The venues' fees, estimated; 0 when every position was simulated. */
  feeCents: number;
  payoutCents: number;
  /** `payoutCents - costCents - feeCents`. */
  pnlCents: number;
  /** True when any fee is counted, so a reader says once that fees are estimated. */
  feesEstimated: boolean;
}

/** A settlement's estimated fee, 0 when it has none. */
export function settlementFeeCents(doc: Pick<Settlement, "feeCents">): number {
  return doc.feeCents ?? 0;
}

/** The asset of a Gemini crypto ladder's event ticker ("BTC2611202200" is BTC), or null for another. */
export function eventTickerAsset(eventTicker: string): string | null {
  return /^([A-Z]+?)(?:05M|15M)?\d{10}$/.exec(eventTicker)?.[1] ?? null;
}

export function settlementTotals(
  docs: Iterable<Pick<Settlement, "costCents" | "payoutCents" | "feeCents">>,
): SettlementTotals {
  const totals: SettlementTotals = {
    positions: 0,
    costCents: 0,
    feeCents: 0,
    payoutCents: 0,
    pnlCents: 0,
    feesEstimated: false,
  };
  for (const doc of docs) {
    totals.positions += 1;
    totals.costCents += doc.costCents;
    totals.payoutCents += doc.payoutCents;
    if (doc.feeCents !== undefined) {
      totals.feeCents += doc.feeCents;
      totals.feesEstimated = true;
    }
  }
  totals.pnlCents = totals.payoutCents - totals.costCents - totals.feeCents;
  return totals;
}
