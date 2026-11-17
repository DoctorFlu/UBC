"use client";

import { type IntentView, describeReason, intentAnomalies } from "@mandate/shared";
import { Check, X } from "lucide-react";

import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";
import { formatUsdCents } from "@/lib/format";
import { describeMarket, namingCategory } from "@/lib/markets";
import { ownerActionLabel, ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerTx } from "@/lib/owner/useOwnerTx";

import styles from "./domain.module.css";
import { OwnerTxStatus } from "./OwnerTxStatus";

/**
 * Approve or reject an intent waiting for the owner, each by holding or pressing twice. Each is an owner-signed
 * `approveIntent` or `rejectIntent`; the row changes when the console reads the resulting event.
 * `approveIntent` checks every rule again (Policy v2), so an approval can still end as a rejection with that
 * rule's reason, for example "agent paused" or "over budget"; the toast then says which rule and why.
 *
 * `warn` (the default in `block` mode) says beside the buttons why a flagged intent could not come from the
 * MCP server, for example "Gemini lists this market as Sports, the intent says Crypto". A table row leaves
 * it out: its Flagged badge sits beside the verdict, and the warning would widen the table.
 */
export function ApprovalActions({
  intent,
  block = false,
  warn = block,
}: {
  intent: IntentView;
  block?: boolean;
  warn?: boolean;
}) {
  const toast = useToast();
  const { state, send, working, access } = useOwnerTx();
  const blocked = ownerBlockedReason(access);
  const amount = intent.amountCents === null ? "this intent" : formatUsdCents(intent.amountCents);
  const market = intent.market
    ? describeMarket(intent.market, namingCategory(intent)).title
    : `intent ${intent.id.toString()}`;
  const subject = `${amount} on ${market}`;
  const flags = intentAnomalies(intent).map((anomaly) => anomaly.text);
  const byPasskey = access.kind === "owner" && access.signer === "passkey" ? " with your passkey" : "";

  const approve = async () => {
    const result = await send(`Approve intent ${intent.id.toString()}`, {
      functionName: "approveIntent",
      intentId: intent.id,
    });
    if (!result.ok) return;
    const after = result.snapshot?.chain?.intents.find((candidate) => candidate.id === intent.id);
    if (after?.status === "rejected") {
      const reason = describeReason(after.reason ?? "");
      toast({
        title: `Refused by the contract: ${reason.label}`,
        description: `The contract checked ${subject} again and rejected it. ${reason.explanation}`,
        tone: "danger",
      });
    } else {
      toast({ title: "Approved", description: `${subject}.`, tone: "success" });
    }
  };

  const reject = async () => {
    const result = await send(`Reject intent ${intent.id.toString()}`, {
      functionName: "rejectIntent",
      intentId: intent.id,
    });
    if (result.ok) toast({ title: "Rejected", description: `${subject}.` });
  };

  return (
    <div className={styles.approvalBlock}>
      {flags.length > 0 && warn ? (
        <p className={styles.approvalWarning} data-testid="approval-warning">
          The MCP server could not have sent this intent: {flags.join("; ")}. Reject it unless you know who
          proposed it.
        </p>
      ) : null}
      <div className={styles.approval} data-block={block || undefined}>
        <HoldButton
          tone="ink"
          size="sm"
          block={block}
          icon={<Check aria-hidden />}
          confirmedLabel="Approving"
          armedLabel={ownerActionLabel(access, "Confirm approval")}
          aria-label={`Approve ${subject}${byPasskey}`}
          disabled={working || blocked !== null}
          onConfirm={() => void approve()}
        >
          {ownerActionLabel(access, "Approve")}
        </HoldButton>
        <HoldButton
          tone="neutral"
          size="sm"
          block={block}
          icon={<X aria-hidden />}
          confirmedLabel="Rejecting"
          armedLabel={ownerActionLabel(access, "Confirm rejection")}
          aria-label={`Reject ${subject}${byPasskey}`}
          disabled={working || blocked !== null}
          onConfirm={() => void reject()}
        >
          {ownerActionLabel(access, "Reject")}
        </HoldButton>
      </div>
      {blocked && access.kind !== "loading" ? <p className={styles.approvalNote}>{blocked}</p> : null}
      <OwnerTxStatus state={state} />
    </div>
  );
}
