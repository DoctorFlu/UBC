import {
  type FillOutcome,
  type FillWords,
  type IntentView,
  fillOutcome,
  fillWords,
  intentAnomalies,
} from "@mandate/shared";

import type { VenueOrderView } from "@/lib/live/types";

/** What the executor's journal adds to an intent's status, and the words for it (`@mandate/shared` fill-words). */
export interface IntentFill {
  kind: Exclude<FillOutcome["kind"], "as_status">;
  outcome: FillOutcome;
  words: FillWords;
}

type FillFields = Pick<
  IntentView,
  "status" | "amountCents" | "filledCents" | "market" | "outcome" | "category" | "limitPrice" | "outOfRange"
> & { listing?: IntentView["listing"] };

/**
 * The fill as the owner should read it, or null when the contract's status says it all: always for an intent
 * with no journal row (the simulated venue), so those read exactly as before.
 */
export function intentFill(intent: FillFields, order: VenueOrderView | null | undefined): IntentFill | null {
  const flags = intentAnomalies(intent).map((anomaly) => anomaly.text);
  const outcome = fillOutcome(intent, order, flags);
  const words = fillWords(outcome);
  if (outcome.kind === "as_status" || words === null) return null;
  return { kind: outcome.kind, outcome, words };
}

/** A status chip's words for an intent: its own, or what the executor's journal adds (`StatusChip`'s props). */
export function fillChipProps(fill: IntentFill | null): {
  label: string | undefined;
  description: string | undefined;
  fill: string | undefined;
} {
  return { label: fill?.words.label, description: fill?.words.sentence, fill: fill?.kind };
}

/** Contracts filled when only part of the order filled, for the order line; null otherwise. */
export function partFilledHundredths(fill: IntentFill | null): number | null {
  if (fill === null) return null;
  const { outcome } = fill;
  if (outcome.kind === "partly_filled") return outcome.filledHundredths;
  if (outcome.kind === "recording" && outcome.partly) return outcome.filledHundredths;
  return null;
}

/** The order line's facts from the executor's order: the contracts placed and, for a partial fill, filled. */
export function orderLine(
  intent: FillFields,
  order: VenueOrderView | null | undefined,
): { placedHundredths: number | null; partFilledHundredths: number | null } {
  return {
    placedHundredths: order?.quantityHundredths ?? null,
    partFilledHundredths: partFilledHundredths(intentFill(intent, order)),
  };
}
