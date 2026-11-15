import { FlaskConical, MessageSquareDiff } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import type { Agent, ChangeRequest, Mandate } from "@/lib/domain";
import { formatDateUtc, formatTimeUtc, formatUsdCents } from "@/lib/format";

import { ChangeRequestActions } from "./ChangeRequestActions";
import { MandateEditor } from "./MandateEditor";
import styles from "./mandate.module.css";

export interface MandateData {
  agent: Agent;
  mandate: Mandate;
  changeRequests: readonly ChangeRequest[];
}

const fieldLabels: Record<ChangeRequest["field"], string> = {
  totalBudgetCents: "total budget",
  maxOrderCents: "max order size",
  approvalThresholdCents: "approval threshold",
  dailyLossLimitCents: "daily loss limit",
};

function requestSummary(agent: Agent, request: ChangeRequest) {
  const verb = request.toCents > request.fromCents ? "raise" : "lower";
  return `${agent.name} asks to ${verb} the ${fieldLabels[request.field]} from ${formatUsdCents(request.fromCents)} to ${formatUsdCents(request.toCents)}`;
}

function Backtest() {
  return (
    <Card>
      <EmptyState icon={<FlaskConical strokeWidth={1.75} />} title="No backtest yet">
        A backtest replays the last 30 days of intents against a draft, so you see which would have been
        approved, held or rejected before you sign it. It arrives with the backtest service.
      </EmptyState>
    </Card>
  );
}

function ChangeRequests({ agent, requests }: { agent: Agent; requests: readonly ChangeRequest[] }) {
  if (requests.length === 0) {
    return (
      <Card>
        <EmptyState icon={<MessageSquareDiff strokeWidth={1.75} />} title="No change requests">
          When {agent.name} hits a limit it thinks is wrong, it can ask you to change it. Requests wait here;
          the mandate never changes without your signature.
        </EmptyState>
      </Card>
    );
  }
  return (
    <ul className={styles.requests}>
      {requests.map((request) => {
        const summary = requestSummary(agent, request);
        return (
          <li key={request.id}>
            <Card tone="attention" title={`${summary}.`} headingLevel={3}>
              <div className={styles.request}>
                <blockquote className={styles.reason}>
                  <p>{request.reason}</p>
                  <footer>
                    {agent.name}, {formatDateUtc(request.at)} at {formatTimeUtc(request.at)}
                  </footer>
                </blockquote>
                <ChangeRequestActions summary={summary} />
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export function MandateView({ agent, mandate, changeRequests }: MandateData) {
  return (
    <div>
      <PageHeader
        title="Mandate"
        description="The rules the Policy contract checks on every intent. Nothing here changes until you sign it."
        meta={
          <>
            <span>
              Version {mandate.version}, set {formatDateUtc(mandate.updatedAt)}
            </span>
            <HexValue label="Signed in" value={mandate.updateTx} kind="tx" />
          </>
        }
      />
      <Tabs
        label="Mandate sections"
        tabs={[
          { id: "rules", label: "Rules", content: <MandateEditor mandate={mandate} /> },
          { id: "backtest", label: "Backtest", content: <Backtest /> },
          {
            id: "requests",
            label: "Change requests",
            count: changeRequests.length,
            content: <ChangeRequests agent={agent} requests={changeRequests} />,
          },
        ]}
      />
    </div>
  );
}
