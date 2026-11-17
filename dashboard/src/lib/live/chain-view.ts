import {
  type Intent,
  type PolicyViewState,
  listIntents,
  lossTodayCents,
  mergeIntentDetails,
} from "@mandate/shared";

import type { ChainView, SealedReason, SettlementView } from "./types";

/**
 * The ChainView of a reduced event log at `head`. `details` fills intents no event described (a proposal
 * rejected on a contract without `IntentProposed`); `sealed` carries the checked decision contexts and
 * `settlements` the checked settlement records. Pure, so the console service and the fixtures build
 * views the same way.
 */
export function buildChainView(
  state: PolicyViewState,
  head: { blockNumber: number; timestamp: number },
  details: ReadonlyMap<number, Intent> = new Map(),
  sealed: Record<number, SealedReason> = {},
  settlements: Record<number, SettlementView> = {},
): ChainView {
  const intents = listIntents(state).map((intent) => {
    const stored = details.get(intent.id);
    return stored && (intent.market === null || intent.category === null)
      ? mergeIntentDetails(intent, stored)
      : intent;
  });
  const policyEvents = state.events.filter((event) => event.type === "PolicyUpdated");
  const lastPolicy = policyEvents.at(-1);
  return {
    head,
    rules: state.rules,
    paused: state.paused,
    committedCents: state.committedCents,
    lossTodayCents: lossTodayCents(state, head.timestamp),
    realizedPnlCents: state.realizedPnlCents,
    rejectionsByReason: state.rejectionsByReason,
    counts: state.counts,
    intents,
    events: state.events,
    policyVersion: policyEvents.length,
    policySetBy: lastPolicy
      ? {
          blockNumber: lastPolicy.blockNumber,
          timestamp: lastPolicy.blockTimestamp,
          txHash: lastPolicy.transactionHash,
        }
      : null,
    sealed,
    settlements,
    venueOrders: {},
    venue: null,
  };
}
