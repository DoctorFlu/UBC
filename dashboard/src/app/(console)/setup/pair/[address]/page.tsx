import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";

import { PairClaimView } from "@/features/setup";
import { getConsoleService } from "@/server/console";

export const metadata: Metadata = { title: "Confirm the agent" };

/** The link the agent's MCP server gives the owner after it announces itself. */
export default async function PairClaimPage({ params }: PageProps<"/setup/pair/[address]">) {
  const { address: raw } = await params;
  if (!isAddress(raw, { strict: false })) notFound();
  const address = getAddress(raw);
  return <PairClaimView address={address} initial={getConsoleService().pairingView(address)} />;
}
