"use client";

import type { PolicyChangeRequest, PolicyRules } from "@mandate/shared";
import { Check, MessageSquareDiff, X } from "lucide-react";
import { useState } from "react";

import { AgentReason } from "@/components/domain/AgentReason";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { EmptyState } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { When } from "@/components/ui/When";

import type { ChainView } from "@/lib/live/types";
import { ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerRequest } from "@/lib/owner/useOwnerRequest";

import styles from "./rules.module.css";
import { BacktestPanel } from "./BacktestPanel";
import { PolicyReview } from "./PolicyReview";
import { type RuleChange, requestedValues, rulesDiff } from "./rules-diff";

type History = Pick<ChainView, "events" | "intents">;

const diffColumns: readonly Column<RuleChange>[] = [
  { key: "rule", header: "Rule", cell: (change) => change.label, role: "primary" },
  {
    key: "now",
    header: "In force",
    cell: (change) => <span className={styles.from}>{change.from}</span>,
    align: "end",
    nowrap: true,
  },
  {
    key: "requested",
    header: "Requested",
    cell: (change) => <strong className={styles.to}>{change.to}</strong>,
    align: "end",
    nowrap: true,
  },
];

const requestedColumns: readonly Column<RuleChange>[] = [
  { key: "rule", header: "Rule", cell: (change) => change.label, role: "primary" },
  { key: "requested", header: "Requested", cell: (change) => change.to, align: "end", nowrap: true },
];

async function markApplied(id: string, txHash: string): Promise<string | null> {
  const response = await fetch(`/api/console/change-requests/${encodeURIComponent(id)}/applied`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  if (response.ok) return null;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `The console answered ${response.status.toString()}.`;
  } catch {
    return `The console answered ${response.status.toString()}.`;
  }
}

function RequestCard({
  request,
  rules,
  chain,
  agentName,
}: {
  request: PolicyChangeRequest;
  rules: PolicyRules | null;
  chain: History;
  agentName: string;
}) {
  const toast = useToast();
  const { request: ownerRequest, pending, access } = useOwnerRequest();
  const [reviewing, setReviewing] = useState(false);
  const blocked = ownerBlockedReason(access);
  const next: PolicyRules | null = rules ? { ...rules, ...request.proposed } : null;
  const pendingRequest = request.status === "pending";
  const changes = next && pendingRequest ? rulesDiff(rules, next) : [];
  // A closed request is history: say what was asked, not how it compares to the rules in force now.
  const requested = requestedValues(request.proposed);
  const summary = !pendingRequest
    ? `${agentName} asked to change ${requested.map((value) => value.label.toLowerCase()).join(", ")}`
    : changes.length === 0
      ? `${agentName} asks for rules that are already in force`
      : `${agentName} asks to change ${changes.map((change) => change.label.toLowerCase()).join(", ")}`;

  const dismiss = async () => {
    const result = await ownerRequest(
      `/api/console/change-requests/${encodeURIComponent(request.id)}/dismiss`,
      "POST",
      "change-request.dismiss",
      { id: request.id },
    );
    toast(
      result.ok
        ? { title: "Request dismissed", description: "The rules stay as they are." }
        : { title: "Not dismissed", description: result.message, tone: "danger" },
    );
  };

  return (
    <li data-testid="change-request" data-status={request.status}>
      <Card tone={pendingRequest ? "attention" : "default"} title={`${summary}.`} headingLevel={3}>
        <div className={styles.request}>
          {changes.length > 0 ? (
            <div className={styles.sideBySide} data-testid="request-diff">
              <Table
                caption="The rules in force beside the rules the agent requests"
                captionHidden
                columns={diffColumns}
                rows={changes}
                rowKey={(change) => change.label}
              />
            </div>
          ) : null}
          {!pendingRequest && requested.length > 0 ? (
            <div className={styles.sideBySide}>
              <Table
                caption="The rules the agent asked for"
                captionHidden
                columns={requestedColumns}
                rows={requested}
                rowKey={(value) => value.label}
              />
            </div>
          ) : null}
          <AgentReason
            text={request.reason}
            footer={
              <>
                {agentName}, <When inSentence at={request.createdAt} date />
              </>
            }
          />
          {pendingRequest && next && changes.length > 0 ? (
            <section className={styles.requestBacktest} aria-label="Backtest of the requested rules">
              <h4 className={styles.subheading}>Backtest of the requested rules</h4>
              <BacktestPanel chain={chain} draft={next} subject="the requested rules" />
            </section>
          ) : null}
          {pendingRequest ? (
            <div className={styles.requestActions}>
              <Button
                variant="primary"
                icon={<Check aria-hidden />}
                onClick={() => setReviewing(true)}
                disabled={!next || changes.length === 0 || blocked !== null}
              >
                Review and sign
              </Button>
              <Button
                variant="secondary"
                icon={<X aria-hidden />}
                onClick={() => void dismiss()}
                loading={pending}
                disabled={blocked !== null}
              >
                Dismiss
              </Button>
              {blocked && access.kind !== "loading" ? <p className={styles.blockedNote}>{blocked}</p> : null}
            </div>
          ) : (
            <p className={styles.resolved}>
              {request.status === "applied" ? "Applied" : "Dismissed"}
              {request.resolvedAt ? (
                <>
                  {" "}
                  <When inSentence at={request.resolvedAt} date />
                </>
              ) : (
                ""
              )}
              {request.appliedTxHash ? <HexValue label="in" value={request.appliedTxHash} kind="tx" /> : null}
            </p>
          )}
        </div>
      </Card>
      {/* Stays mounted after the request closes, so the owner sees the signed step and its Done button. */}
      {next && (pendingRequest || reviewing) ? (
        <PolicyReview
          open={reviewing}
          onClose={() => setReviewing(false)}
          next={next}
          title="Apply the agent's request"
          onSigned={async (hash) => {
            const problem = await markApplied(request.id, hash);
            if (problem)
              toast({ title: "Signed, but not marked applied", description: problem, tone: "danger" });
          }}
        />
      ) : null}
    </li>
  );
}

/** The agent's requests to change the rules. Nothing changes until the owner signs `setPolicy`. */
export function ChangeRequests({
  requests,
  rules,
  chain,
  agentName,
}: {
  requests: readonly PolicyChangeRequest[];
  rules: PolicyRules | null;
  chain: History;
  agentName: string;
}) {
  if (requests.length === 0) {
    return (
      <Card>
        <EmptyState icon={<MessageSquareDiff strokeWidth={1.75} />} title="No change requests">
          When {agentName === "The agent" ? "the agent" : agentName} hits a limit it thinks is wrong, it can
          ask you to change it. Requests wait here; the rules never change without your signature.
        </EmptyState>
      </Card>
    );
  }
  return (
    <ul className={styles.requests}>
      {requests.map((request) => (
        <RequestCard key={request.id} request={request} rules={rules} chain={chain} agentName={agentName} />
      ))}
    </ul>
  );
}
