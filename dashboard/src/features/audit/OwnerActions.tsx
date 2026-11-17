"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { type Column, Table } from "@/components/ui/Table";
import { When } from "@/components/ui/When";
import { useAdvancedColumns } from "@/lib/advanced/Advanced";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { useMandateUrls } from "@/lib/mandate/MandateContext";

import styles from "./audit.module.css";

/** One owner action a member confirmed in the console (#95), as GET /api/console/owner-actions lists it. */
interface OwnerAction {
  id: string;
  memberName: string | null;
  credentialId: string | null;
  functionName: string;
  status: "sent" | "failed";
  txHash: `0x${string}` | null;
  detail: string | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  setPolicy: "Set the rules",
  setPaused: "Paused or resumed the agent",
  approveIntent: "Approved an intent",
  rejectIntent: "Rejected an intent",
  "mandate.create": "Created the mandate",
  "token.create": "Created an agent token",
  "holdings.save": "Saved holdings",
  "pairing.confirm": "Confirmed the agent",
  "change-request.dismiss": "Dismissed a change request",
};

function actionText(action: OwnerAction): string {
  const label = ACTION_LABELS[action.functionName] ?? action.functionName;
  return action.detail ? `${label}: ${action.detail}` : label;
}

const COLUMNS: Column<OwnerAction>[] = [
  { key: "when", header: "When", nowrap: true, cell: (action) => <When at={action.createdAt} /> },
  { key: "action", header: "Action", role: "primary", cell: actionText },
  { key: "who", header: "Member", cell: (action) => action.memberName ?? "A former member" },
  {
    key: "how",
    header: "Confirmed by",
    cell: (action) => (action.credentialId ? "Passkey" : "Session (a pause needs no passkey)"),
  },
  {
    key: "status",
    header: "Result",
    nowrap: true,
    cell: (action) => (action.status === "sent" ? "Done" : "Refused"),
  },
  {
    key: "tx",
    header: "Transaction",
    advanced: true,
    cell: (action) => (action.txHash ? <HexValue value={action.txHash} kind="tx" /> : "Offchain"),
  },
];

/**
 * What members confirmed in the console for this mandate (#95): who, how (passkey or session), and what
 * the console sent. Onchain decisions are in the events above; this is who asked for them.
 */
export function OwnerActions() {
  const { api } = useMandateUrls();
  const seq = useSnapshot().seq;
  const columns = useAdvancedColumns(COLUMNS);
  const [actions, setActions] = useState<OwnerAction[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    fetch(api("/api/console/owner-actions"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { actions: OwnerAction[] };
        if (current) {
          setActions(body.actions);
          setFailed(false);
        }
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
    // A new snapshot may carry the event of an action just confirmed: read the list again with it.
  }, [api, seq]);

  return (
    <Card
      title="Owner actions"
      description="Who confirmed each change in the console, and how."
      padding="flush"
      headingLevel={2}
      className={styles.ownerActions}
    >
      {failed && actions === null ? (
        <p className={`${styles.none} ${styles.flushNote}`}>
          The console could not list them. They load again with the next update.
        </p>
      ) : (
        <Table
          caption="Owner actions"
          captionHidden
          columns={columns}
          rows={actions ?? []}
          rowKey={(action) => action.id}
          empty={
            <p className={styles.none}>
              {actions === null
                ? "Loading."
                : "None yet. Changes confirmed here are listed with who made them."}
            </p>
          }
        />
      )}
    </Card>
  );
}
