import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type Address, isAddress, isAddressEqual } from "viem";

import { ChainUnavailable } from "@/components/states/ChainStates";
import { ScorecardView } from "@/features/scorecard";
import { NetworkProvider } from "@/lib/live/LiveConsole";
import { getConsoleService } from "@/server/console";

export const dynamic = "force-dynamic";

/** The contract's agent, named as it announced itself when that announcement came from the same key. */
function scorecardAgent(address: string) {
  const snapshot = getConsoleService().snapshot();
  const agent = snapshot.contract?.roles?.agent;
  const known =
    agent !== undefined && isAddress(address, { strict: false }) && isAddressEqual(address, agent);
  const pairing = snapshot.offchain.pairing;
  const paired = known && pairing !== null && isAddressEqual(pairing.agentAddress, agent) ? pairing : null;
  return { snapshot, known, agent: agent ?? null, paired };
}

function shortName(address: Address) {
  return `Agent ${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function generateMetadata({ params }: PageProps<"/agent/[address]">): Promise<Metadata> {
  const { address } = await params;
  const { known, agent, paired } = scorecardAgent(address);
  if (!known || !agent) return { title: "Agent scorecard" };
  return { title: `${paired?.agentName ?? shortName(agent)} scorecard` };
}

/** Public and wallet-free: anyone with the link can check the agent's record, read from the chain. */
export default async function AgentScorecardPage({ params }: PageProps<"/agent/[address]">) {
  const { address } = await params;
  const { snapshot, known, agent, paired } = scorecardAgent(address);
  const roles = snapshot.contract?.roles;
  // Until the console has read the contract it can't say whose scorecard this is.
  if (!roles || !snapshot.chain) return <ChainUnavailable snapshot={snapshot} title="Agent scorecard" />;
  // Only the Policy contract's agent has a record here: every intent on it came from agent().
  if (!known || !agent) notFound();
  return (
    <NetworkProvider network={snapshot.network}>
      <ScorecardView
        agent={{
          address: agent,
          name: paired?.agentName ?? shortName(agent),
          pairedAt: paired?.confirmedAt ?? null,
        }}
        owner={roles.user}
        chain={snapshot.chain}
      />
    </NetworkProvider>
  );
}
