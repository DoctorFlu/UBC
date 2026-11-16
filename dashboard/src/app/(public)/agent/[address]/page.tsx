import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress, isAddressEqual } from "viem";

import { ChainUnavailable } from "@/components/states/ChainStates";
import { ScorecardView } from "@/features/scorecard";
import { NetworkProvider } from "@/lib/live/LiveConsole";
import type { ChainView } from "@/lib/live/types";
import { type PublicScorecard, buildScorecard, publicAgentName } from "@/lib/scorecard/scorecard";
import { getConsoleService } from "@/server/console";

export const dynamic = "force-dynamic";

/**
 * One scorecard per chain view. The console service hands out the same snapshot until the chain changes,
 * so a request costs a lookup however often the public page is loaded: the work is bounded by new
 * events, not by visitors. Weak keys let an old view go with its snapshot.
 */
const scorecards = new WeakMap<ChainView, PublicScorecard>();

function scorecardOf(chain: ChainView): PublicScorecard {
  let card = scorecards.get(chain);
  if (!card) {
    card = buildScorecard(chain);
    scorecards.set(chain, card);
  }
  return card;
}

/**
 * The contract's agent, named as it announced itself when that announcement came from the same key.
 * Nothing caller-chosen reaches a store: an address that is not the contract's agent is a 404 before any
 * other work.
 */
function scorecardAgent(address: string) {
  const snapshot = getConsoleService().snapshot();
  const agent = snapshot.contract?.roles?.agent;
  const known =
    agent !== undefined && isAddress(address, { strict: false }) && isAddressEqual(address, agent);
  const pairing = snapshot.offchain.pairing;
  const paired = known && pairing !== null && isAddressEqual(pairing.agentAddress, agent) ? pairing : null;
  return { snapshot, known, agent: agent ?? null, paired };
}

export async function generateMetadata({ params }: PageProps<"/agent/[address]">): Promise<Metadata> {
  const { address } = await params;
  const { known, agent, paired } = scorecardAgent(address);
  if (!known || !agent) return { title: "Agent scorecard" };
  return { title: `${publicAgentName(paired?.agentName ?? null, agent)} scorecard` };
}

/** Public and wallet-free: anyone with the link can check the agent's record, read from the chain. */
export default async function AgentScorecardPage({ params }: PageProps<"/agent/[address]">) {
  const { address } = await params;
  const { snapshot, known, agent, paired } = scorecardAgent(address);
  const roles = snapshot.contract?.roles;
  const contract = snapshot.contract?.address;
  // Until the console has read the contract it can't say whose scorecard this is.
  if (!roles || !contract || !snapshot.chain) {
    return <ChainUnavailable snapshot={snapshot} title="Agent scorecard" />;
  }
  // Only the Policy contract's agent has a record here: every intent on it came from agent().
  if (!known || !agent) notFound();
  return (
    <NetworkProvider network={snapshot.network}>
      <ScorecardView
        agent={{
          address: agent,
          name: publicAgentName(paired?.agentName ?? null, agent),
          pairedAt: paired?.confirmedAt ?? null,
        }}
        owner={roles.user}
        contract={contract}
        network={snapshot.network}
        card={scorecardOf(snapshot.chain)}
      />
    </NetworkProvider>
  );
}
