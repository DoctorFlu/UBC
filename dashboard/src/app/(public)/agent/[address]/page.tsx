import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress, isAddressEqual } from "viem";

import { ScorecardView } from "@/features/scorecard";
import { agent, intents, mandate, scorecard } from "@/mock";

export async function generateMetadata({ params }: PageProps<"/agent/[address]">): Promise<Metadata> {
  const { address } = await params;
  return {
    title:
      isAddress(address) && isAddressEqual(address, agent.address)
        ? `${agent.name} scorecard`
        : "Agent scorecard",
  };
}

/** Public and wallet-free: anyone with the link can check the agent's record. */
export default async function AgentScorecardPage({ params }: PageProps<"/agent/[address]">) {
  const { address } = await params;
  // Until #38 reads scorecards from the event store, only the mock agent has one.
  if (!isAddress(address) || !isAddressEqual(address, agent.address)) notFound();
  return (
    <ScorecardView
      agent={agent}
      mandate={mandate}
      intents={intents}
      ownerApprovals={scorecard.ownerApprovals}
      hedgeOutcomeCents={scorecard.hedgeOutcomeCents}
    />
  );
}
