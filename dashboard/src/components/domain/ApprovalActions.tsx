"use client";

import { type IntentView, describeReason, intentAnomalies } from "@mandate/shared";
import { Check, X } from "lucide-react";

import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";
import { formatUsdCents } from "@/lib/format";
import { describeMarket, namingCategory } from "@/lib/markets";
import { useMandateUrls } from "@/lib/mandate/MandateContext";
import { type OwnerAccess, ownerActionLabel, ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerTx } from "@/lib/owner/useOwnerTx";

import styles from "./domain.module.css";
import { OwnerTxStatus } from "./OwnerTxStatus";

/**
 * The armed state's words: "Press again", with the action for assistive technology. A hold button is as
 * wide as its longest label, so the visible words stay shorter than the resting ones and the row keeps its
 * width (an approval card or table at 1440 px has no room to spare).
 */
function pressAgain(access: OwnerAccess, action: "approve" | "reject") {
  return (
    <>
      Press again<span className="visually-hidden"> to {action}</span>
      {access.kind === "owner" && access.signer === "passkey" ? " with passkey" : null}
    </>
  );
}

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
  const urls = useMandateUrls();
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
        // It leaves Waiting as it ends rejected; the link says where it went.
        link: {
          label: `See intent #${intent.id.toString()}`,
          href: urls.href(`/activity/${intent.id.toString()}`),
        },
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
          armedLabel={pressAgain(access, "approve")}
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
          armedLabel={pressAgain(access, "reject")}
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
