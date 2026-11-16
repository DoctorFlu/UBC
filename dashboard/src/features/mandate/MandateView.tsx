"use client";

import { ChainUnavailable } from "@/components/states/ChainStates";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { agentName, isoFromUnix } from "@/lib/live/derive";
import type { ConsoleSnapshot } from "@/lib/live/types";

import { ChangeRequests } from "./ChangeRequests";
import { MandateEditor } from "./MandateEditor";

/**
 * The rules in force, the editor that signs new ones (with its backtest), and the agent's requests to
 * change them.
 */
export function MandateView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Mandate" />;
  const pending = snapshot.offchain.changeRequests.filter((request) => request.status === "pending").length;
  const setBy = chain.policySetBy;

  return (
    <div>
      <PageHeader
        title="Mandate"
        description="The rules the Policy contract checks on every intent. Nothing here changes until you sign it."
        meta={
          setBy ? (
            <>
              <span>
                Version {chain.policyVersion}, set {formatDateUtc(isoFromUnix(setBy.timestamp))} at{" "}
                {formatTimeUtc(isoFromUnix(setBy.timestamp))}
              </span>
              <HexValue label="Signed in" value={setBy.txHash} kind="tx" />
            </>
          ) : (
            <span>No mandate signed yet</span>
          )
        }
      />
      <Tabs
        label="Mandate sections"
        defaultTab={pending > 0 ? "requests" : "rules"}
        tabs={[
          {
            id: "rules",
            label: "Rules",
            content: <MandateEditor rules={chain.rules} version={chain.policyVersion} chain={chain} />,
          },
          {
            id: "requests",
            label: "Change requests",
            count: pending,
            content: (
              <ChangeRequests
                requests={snapshot.offchain.changeRequests}
                rules={chain.rules}
                chain={chain}
                agentName={agentName(snapshot)}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
