/**
 * The protection already held on one ladder, read from what the Policy contract and the executor
 * record: filled intents, approved intents the executor has not filled yet, and intents waiting for the
 * owner's approval. `@mandate/planner` turns them into positions and measures cover against a goal, so
 * no tool (and no model) ever adds them up by hand.
 */
import { positionsFromIntents, type CoverLadder, type IntentPosition } from "@mandate/planner";
import { mergeIntentDetails, type IntentView } from "@mandate/shared";
import type { AgentPolicy } from "../services";

/** Statuses whose intents can count as cover. Rejected and failed intents never do. */
const COUNTED = new Set(["approved", "needs_approval", "executed"]);

/**
 * Every NO buy on this ladder that still counts, one position per intent. Reads the event index (fresh
 * as of the call) and, on a contract without `IntentProposed`, the stored details of the few intents
 * whose events do not carry their market. Throws when the chain cannot be read: a caller that cannot
 * see the positions must not trade.
 */
export async function heldPositions(
  policy: AgentPolicy,
  ladder: Pick<CoverLadder, "rungs">,
): Promise<IntentPosition[]> {
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
  return positionsFromIntents(complete, ladder);
}
