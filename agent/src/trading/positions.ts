/**
 * The protection already held on one ladder, read from what the Policy contract and the executor
 * record: filled intents, approved intents the executor has not filled yet, and intents waiting for the
 * owner's approval. `@mandate/planner` turns them into positions and measures cover against a goal, so
 * no tool (and no model) ever adds them up by hand.
 */
import {
  positionsFromIntents,
  symbolsMissingFromLadder,
  type CoverLadder,
  type IntentPosition,
} from "@mandate/planner";
import { mergeIntentDetails, type IntentView } from "@mandate/shared";
import type { AgentPolicy, MarketsClient } from "../services";

/** Statuses whose intents can count as cover. Rejected and failed intents never do. */
const COUNTED = new Set(["approved", "needs_approval", "executed"]);

export interface HeldOnLadder {
  positions: IntentPosition[];
  /**
   * Strikes of held symbols the ladder does not list, read from Gemini's production exchange: fills the
   * simulated venue made before the stack traded on the sandbox. Empty when the ladder lists them all.
   */
  elsewhere: ReadonlyMap<string, number>;
}

/**
 * Every NO buy on this ladder that still counts, one position per intent. Reads the event index (fresh
 * as of the call) and, on a contract without `IntentProposed`, the stored details of the few intents
 * whose events do not carry their market. A held symbol the ladder does not list is looked up on
 * production, where the simulated venue filled it (a strike belongs to its symbol on every exchange).
 * Throws when the chain or that lookup cannot be read, or when nobody lists a held strike
 * (`UnresolvedPositionError`): a caller that cannot see the positions must not trade.
 */
export async function heldPositions(
  policy: AgentPolicy,
  ladder: Pick<CoverLadder, "eventTicker" | "rungs">,
  markets: Pick<MarketsClient, "productionStrikes"> | undefined,
): Promise<HeldOnLadder> {
  const views = [...(await policy.intentEvents()).values()].filter((view) => COUNTED.has(view.status));
  const complete = await Promise.all(
    views.map(async (view): Promise<IntentView> => {
      if (view.market !== null && view.outcome !== null && view.isBuy !== null && view.limitPrice !== null) {
        return view;
      }
      const stored = await policy.intent(view.id);
      return stored === null ? view : mergeIntentDetails(view, stored);
    }),
  );
  const missing = symbolsMissingFromLadder(complete, ladder);
  let elsewhere: ReadonlyMap<string, number> = new Map();
  if (missing.length > 0 && markets !== undefined) {
    const strikes = await markets.productionStrikes(ladder.eventTicker);
    elsewhere = new Map(
      missing.flatMap((symbol) => {
        const strike = strikes.get(symbol);
        return strike === undefined ? [] : [[symbol, strike] as const];
      }),
    );
  }
  return { positions: positionsFromIntents(complete, ladder, elsewhere), elsewhere };
}
