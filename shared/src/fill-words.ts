/**
 * How a fill reads to the owner, from the intent's status onchain and the executor's journal of the order it
 * placed (issue #93). The one source of these words: the console's chips, sentences, timeline, order lines
 * and plan lines, and `get_activity`'s summary all use it, so a partly filled order never reads as a full fill.
 *
 * The contract records one result per intent, filled or not, with the amount filled. The journal says more: a
 * Gemini order can close with part of it filled (`partly_filled`), and the executor records the result onchain
 * only after the order closes, retrying for minutes when the chain does not answer. An intent with no journal
 * row (filled by the simulated venue, or before the journal existed) reads exactly as its status.
 */
import type { IntentStatus } from "./reasons";
import { formatCents } from "./units";
import type { VenueOrderState } from "./venue-order";

/** The journal's facts about one order, as both the console's view and the agent API carry them. */
export interface JournalOrder {
  environment: "sandbox" | "production";
  state: VenueOrderState;
  quantityHundredths: number;
  filledHundredths: number;
  filledCents: number;
}

/** The intent's facts onchain that the words depend on. */
export interface FillIntent {
  status: IntentStatus;
  amountCents: number | null;
  /** What the executor recorded as filled onchain, or null before a result (or when too large to show). */
  filledCents: number | null;
}

/**
 * - `as_status`: nothing to add to the contract's status.
 * - `partly_filled`: executed onchain, and the journal says only part of the order filled.
 * - `recording`: the order closed with something filled at the venue, and the result is not onchain yet.
 * - `refused_before_sending`: not filled, and the intent is one the executor refuses without sending an order
 *   (`flags`: why, as the console words its anomalies).
 * - `venue_refused`: not filled, because the venue refused the order (`detail`: the executor's note).
 * - `cancelled_unfilled`: not filled: the order rested at the venue and closed with nothing filled.
 */
export type FillOutcome =
  | { kind: "as_status" }
  | {
      kind: "partly_filled";
      filledHundredths: number;
      quantityHundredths: number;
      filledCents: number;
      amountCents: number | null;
    }
  | {
      kind: "recording";
      venue: string;
      partly: boolean;
      filledHundredths: number;
      quantityHundredths: number;
    }
  | { kind: "refused_before_sending"; flags: readonly string[] }
  | { kind: "venue_refused"; venue: string; detail: string | null }
  | { kind: "cancelled_unfilled"; venue: string };

/** "Gemini" or "Gemini sandbox", as the console names the venue. */
export function venueName(environment: JournalOrder["environment"]): string {
  return environment === "production" ? "Gemini" : "Gemini sandbox";
}

/**
 * `flags`: why the executor would refuse the intent without sending an order (the console's anomalies, for
 * example "Gemini does not list this market"); only a failed intent uses them.
 */
export function fillOutcome(
  intent: FillIntent,
  order: (JournalOrder & { detail?: string | null }) | null | undefined,
  flags: readonly string[] = [],
): FillOutcome {
  if (intent.status === "failed") {
    if (order?.state === "rejected") {
      return { kind: "venue_refused", venue: venueName(order.environment), detail: order.detail ?? null };
    }
    if (order?.state === "cancelled")
      return { kind: "cancelled_unfilled", venue: venueName(order.environment) };
    if (flags.length > 0 && (order === null || order === undefined)) {
      return { kind: "refused_before_sending", flags };
    }
    return { kind: "as_status" };
  }
  if (order === null || order === undefined) return { kind: "as_status" };
  const somethingFilled =
    order.state === "filled" || (order.state === "partly_filled" && order.filledHundredths > 0);
  if (intent.status === "approved" && somethingFilled) {
    return {
      kind: "recording",
      venue: venueName(order.environment),
      partly: order.state === "partly_filled",
      filledHundredths: order.filledHundredths,
      quantityHundredths: order.quantityHundredths,
    };
  }
  if (intent.status === "executed" && order.state === "partly_filled" && order.filledHundredths > 0) {
    return {
      kind: "partly_filled",
      filledHundredths: order.filledHundredths,
      quantityHundredths: order.quantityHundredths,
      // What the contract recorded is what the budget and the cover count; the journal's is the fallback.
      filledCents: intent.filledCents ?? order.filledCents,
      amountCents: intent.amountCents,
    };
  }
  return { kind: "as_status" };
}

/**
 * Contracts from hundredths: 500 -> "5", 1250 -> "12.50", 123456 -> "1,234.56". Exact, never rounded to whole
 * contracts; a whole number drops its ".00".
 */
export function formatContractCount(hundredths: number): string {
  const whole = Math.floor(hundredths / 100).toLocaleString("en-US");
  const fraction = hundredths % 100;
  return fraction === 0 ? whole : `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** "5 of 12.50": contracts filled of contracts placed. */
export function filledOfPlaced(outcome: { filledHundredths: number; quantityHundredths: number }): string {
  return `${formatContractCount(outcome.filledHundredths)} of ${formatContractCount(outcome.quantityHundredths)}`;
}

export interface FillWords {
  /** For the chip, in place of the status's own word. */
  label: string;
  /** One sentence for the chip's description and wherever the result is told in full. */
  sentence: string;
  /** The timeline step's title. */
  step: string;
  /** The timeline step's text under that title: the sentence without what the title already says. */
  detail: string;
}

/** "Partly filled: 5 of ...": a sentence that starts with its label, and the rest of it on its own. */
function told(label: string, step: string, rest: string): FillWords {
  return { label, sentence: `${label}: ${rest}`, step, detail: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/** The words for an outcome, or null when the contract's status says it all (`as_status`). */
export function fillWords(outcome: FillOutcome): FillWords | null {
  switch (outcome.kind) {
    case "as_status":
      return null;
    case "partly_filled": {
      const money =
        outcome.amountCents === null
          ? formatCents(outcome.filledCents)
          : `${formatCents(outcome.filledCents)} of ${formatCents(outcome.amountCents)}`;
      return told(
        "Partly filled",
        "Partly filled",
        `${filledOfPlaced(outcome)} contracts, ${money}. The rest was cancelled and its budget released.`,
      );
    }
    case "recording": {
      const what = outcome.partly
        ? `Partly filled at ${outcome.venue} (${filledOfPlaced(outcome)} contracts)`
        : `Filled at ${outcome.venue}`;
      return {
        label: outcome.partly ? `Partly filled at ${outcome.venue}` : `Filled at ${outcome.venue}`,
        sentence: `${what}; recording the result onchain.`,
        step: `${outcome.partly ? "Partly filled" : "Filled"} at ${outcome.venue}; recording the result onchain`,
        detail: "The executor records the result onchain next; until then the budget still holds the full amount.",
      };
    }
    case "refused_before_sending":
      return told(
        NOT_FILLED,
        "Refused by the executor",
        `the executor refused it before sending any order, because ${outcome.flags.join("; ")}. ${RELEASED}`,
      );
    case "venue_refused":
      return told(
        NOT_FILLED,
        `Refused by ${outcome.venue}`,
        `${outcome.detail === null ? `${outcome.venue} refused the order` : outcome.detail}. ${RELEASED}`,
      );
    case "cancelled_unfilled":
      return told(
        NOT_FILLED,
        "Did not fill",
        `the order rested on ${outcome.venue} and was cancelled with nothing filled. ${RELEASED}`,
      );
  }
}

/** The console's word for a failed intent; the contract's own is "Failed". */
export const NOT_FILLED = "Not filled";
const RELEASED = "Its amount went back to the budget.";

/** How a plan's or a list's executed intents split: in full, in part. Each intent counts once. */
export function countFills(
  entries: readonly { intent: FillIntent; order: JournalOrder | null | undefined }[],
): { filled: number; partlyFilled: number } {
  let filled = 0;
  let partlyFilled = 0;
  for (const { intent, order } of entries) {
    if (intent.status !== "executed") continue;
    if (fillOutcome(intent, order).kind === "partly_filled") partlyFilled += 1;
    else filled += 1;
  }
  return { filled, partlyFilled };
}
