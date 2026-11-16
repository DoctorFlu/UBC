/**
 * Backtest: replays the intents the console has stored through a draft mandate, with the same rule
 * logic the contract runs (`evaluateIntent` from `@mandate/shared`, which the devchain fuzz test holds
 * to the contract). Nothing here is sent anywhere; it only answers "what would the contract have said".
 *
 * The replay walks the Policy events in chain order and keeps its own account of the state the rules
 * read (committed budget and today's realized loss), as it would have been under the draft:
 * - a buy the draft approves commits its amount, and the executor's recorded fill releases what did not
 *   fill, exactly as the contract does;
 * - a held intent the owner really approved is approved again under the draft (the contract re-checks
 *   only the budget on approval); one the owner never saw stays held;
 * - a loss counts toward the daily limit only if the draft would have let that intent trade.
 *
 * The kill switch is not a rule the draft changes, so each intent is replayed with the pause state it
 * actually met.
 */
import { type PolicyRules, evaluateIntent } from "@mandate/shared";

import { utcDay } from "@/lib/live/derive";
import type { ChainView } from "@/lib/live/types";

export type Verdict = { kind: "approved" } | { kind: "held" } | { kind: "rejected"; reason: string };

export interface ReplayedIntent {
  id: number;
  market: string | null;
  amountCents: number | null;
  isBuy: boolean | null;
  /** The contract's answer when the intent was proposed. */
  actual: Verdict;
  /** The draft's answer, or null when the console does not know the intent's details. */
  draft: Verdict | null;
  changed: boolean;
}

export interface VerdictCounts {
  approved: number;
  held: number;
  rejected: number;
}

export interface BacktestResult {
  intents: ReplayedIntent[];
  actual: VerdictCounts;
  /** Only intents the replay could evaluate. */
  draft: VerdictCounts;
  /** Intents whose verdict differs, in id order. */
  changed: ReplayedIntent[];
  /** Intents without enough detail to replay. */
  unknown: number;
}

function count(verdicts: readonly (Verdict | null)[]): VerdictCounts {
  const counts: VerdictCounts = { approved: 0, held: 0, rejected: 0 };
  for (const verdict of verdicts) if (verdict) counts[verdict.kind] += 1;
  return counts;
}

function sameVerdict(a: Verdict, b: Verdict): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "rejected" || (b.kind === "rejected" && a.reason === b.reason);
}

/** Replays every intent in `chain` through `draft`. `draft.paused` is ignored: see the module note. */
export function backtest(chain: Pick<ChainView, "events" | "intents">, draft: PolicyRules): BacktestResult {
  const details = new Map(chain.intents.map((intent) => [intent.id, intent]));
  const actual = new Map<number, Verdict>();
  const replayed = new Map<number, Verdict | null>();
  /** Intents the draft lets trade, so their recorded losses count toward its daily limit. */
  const trading = new Set<number>();
  const openBuys = new Map<number, number>();
  const lossByDay = new Map<number, number>();
  let committedCents = 0;
  let paused = false;

  const evaluate = (id: number, at: number): Verdict | null => {
    const intent = details.get(id);
    if (!intent || intent.category === null || intent.isBuy === null || intent.amountCents === null) {
      return null;
    }
    const evaluation = evaluateIntent(
      { ...draft, paused },
      { committedCents, lossTodayCents: lossByDay.get(utcDay(at)) ?? 0 },
      { category: intent.category, isBuy: intent.isBuy, amountCents: intent.amountCents },
    );
    if (evaluation.verdict === "rejected") return { kind: "rejected", reason: evaluation.reason };
    return evaluation.verdict === "approved" ? { kind: "approved" } : { kind: "held" };
  };

  const trade = (id: number) => {
    const intent = details.get(id);
    trading.add(id);
    if (intent?.isBuy && intent.amountCents !== null) {
      committedCents += intent.amountCents;
      openBuys.set(id, intent.amountCents);
    }
  };

  for (const event of chain.events) {
    switch (event.type) {
      case "PolicyUpdated":
        paused = event.rules.paused;
        continue;
      case "Paused":
        paused = event.paused;
        continue;
      case "IntentProposed":
        // The verdict follows in the same transaction; the proposal itself decides nothing.
        continue;
      default:
        break;
    }

    const id = event.intentId;
    if (!actual.has(id)) {
      // The first verdict event of an intent is the contract's answer to its proposal.
      if (event.type === "ResultRecorded") continue;
      const verdict: Verdict =
        event.type === "IntentApproved"
          ? { kind: "approved" }
          : event.type === "IntentNeedsApproval"
            ? { kind: "held" }
            : { kind: "rejected", reason: event.reason };
      actual.set(id, verdict);
      const draftVerdict = evaluate(id, event.blockTimestamp);
      replayed.set(id, draftVerdict);
      if (draftVerdict?.kind === "approved") trade(id);
      continue;
    }

    if (event.type === "IntentApproved") {
      // The owner approved a held intent. Under the draft it was held too only if the draft said so;
      // then the owner's approval stands, subject to the budget check `approveIntent` makes.
      const intent = details.get(id);
      if (replayed.get(id)?.kind === "held" && intent?.amountCents != null) {
        const fits = !intent.isBuy || committedCents + intent.amountCents <= draft.budgetCents;
        if (fits) trade(id);
      }
      continue;
    }

    if (event.type === "ResultRecorded") {
      // As the shared reducer does: a fill or P&L too large for offchain code is flagged, never counted.
      const open = openBuys.get(id);
      if (open !== undefined && event.filledCents !== null) {
        committedCents -= open - event.filledCents;
        openBuys.delete(id);
      }
      if (trading.has(id) && event.pnlCents !== null && event.pnlCents < 0) {
        const day = utcDay(event.blockTimestamp);
        lossByDay.set(day, (lossByDay.get(day) ?? 0) - event.pnlCents);
      }
    }
  }

  const intents: ReplayedIntent[] = [...actual.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, verdict]) => {
      const intent = details.get(id);
      const draftVerdict = replayed.get(id) ?? null;
      return {
        id,
        market: intent?.market ?? null,
        amountCents: intent?.amountCents ?? null,
        isBuy: intent?.isBuy ?? null,
        actual: verdict,
        draft: draftVerdict,
        changed: draftVerdict !== null && !sameVerdict(verdict, draftVerdict),
      };
    });

  return {
    intents,
    actual: count(intents.map((intent) => intent.actual)),
    draft: count(intents.map((intent) => intent.draft)),
    changed: intents.filter((intent) => intent.changed),
    unknown: intents.filter((intent) => intent.draft === null).length,
  };
}
