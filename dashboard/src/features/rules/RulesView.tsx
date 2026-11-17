"use client";

import { ChainUnavailable } from "@/components/states/ChainStates";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { useAdvanced } from "@/lib/advanced/Advanced";
import { When } from "@/components/ui/When";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { agentName } from "@/lib/live/derive";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { useQueryTab } from "@/lib/useQueryTab";

import { ChangeRequests } from "./ChangeRequests";
import { RulesEditor } from "./RulesEditor";

export type RulesTab = "rules" | "requests";

/**
 * The rules in force, the editor that signs new ones (with its backtest), and the agent's requests to
 * change them. Opens on the requests while one is pending, unless the address names a tab.
 */
export function RulesView({ tab, preview }: { tab?: RulesTab | undefined; preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const { advanced } = useAdvanced();
  const pending = snapshot.offchain.changeRequests.filter((request) => request.status === "pending").length;
  const fallback: RulesTab = pending > 0 ? "requests" : "rules";
  const [shown, select] = useQueryTab<RulesTab>("tab", tab ?? fallback, fallback);
  const chain = snapshot.chain;
  if (!chain) return <ChainUnavailable snapshot={snapshot} title="Rules" />;
  const setBy = chain.policySetBy;

  return (
    <div>
      <PageHeader
        title="Rules"
        description="The Policy contract checks every intent against these rules. Nothing here changes until you confirm it."
        meta={
          setBy ? (
            <>
              <span>
                Version {chain.policyVersion}, set <When inSentence at={setBy.timestamp} date />
              </span>
              {advanced ? <HexValue label="Signed in" value={setBy.txHash} kind="tx" /> : null}
            </>
          ) : (
            <span>No rules signed yet</span>
          )
        }
      />
      <Tabs
        label="Rules sections"
        selected={shown}
        onSelect={(id) => select(id === "requests" ? "requests" : "rules")}
        tabs={[
          {
            id: "rules",
            label: "Rules in force",
            content: <RulesEditor rules={chain.rules} version={chain.policyVersion} chain={chain} />,
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
