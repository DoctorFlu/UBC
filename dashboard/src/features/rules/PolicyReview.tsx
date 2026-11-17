"use client";

import type { PolicyRules } from "@mandate/shared";
import { PenLine, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Hex } from "viem";

import { OwnerTxStatus } from "@/components/domain/OwnerTxStatus";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerTx } from "@/lib/owner/useOwnerTx";

import styles from "./rules.module.css";
import { rulesDiff, rulesWarnings } from "./rules-diff";

export interface PolicyReviewProps {
  open: boolean;
  onClose: () => void;
  /** The rules to sign, complete: `setPolicy` replaces every rule at once. */
  next: PolicyRules;
  title: string;
  /** Called once the transaction is mined, with its hash. */
  onSigned?: (hash: Hex) => void | Promise<void>;
}

/**
 * The step before the wallet prompt: exactly what changes, what it means, and on which contract and
 * network. Signing sends `setPolicy`; the dialog then shows the transaction until the console reads its
 * `PolicyUpdated` event, so every view agrees when it closes.
 */
export function PolicyReview({ open, onClose, next, title, onSigned }: PolicyReviewProps) {
  const snapshot = useSnapshot();
  const toast = useToast();
  const { state, send, working, access, reset } = useOwnerTx();
  const live = snapshot.chain?.rules ?? null;
  // The rules the owner signed against, held from the signature on: once the new rules land they become
  // the live ones, and the diff must not empty itself under the owner's eyes.
  const [signedAgainst, setSignedAgainst] = useState<PolicyRules | null | undefined>(undefined);
  const current = signedAgainst === undefined ? live : signedAgainst;
  const changes = rulesDiff(current, next);
  const warnings = rulesWarnings(next, snapshot.chain?.committedCents ?? 0);
  const blocked = ownerBlockedReason(access);
  const finished = state.phase === "done";

  const close = () => {
    if (working) return;
    reset();
    setSignedAgainst(undefined);
    onClose();
  };

  const sign = async () => {
    setSignedAgainst(live);
    const result = await send(current ? "Update the rules" : "Set the rules", {
      functionName: "setPolicy",
      rules: next,
    });
    if (!result.ok) {
      setSignedAgainst(undefined);
      return;
    }
    // The rules are on the chain once the transaction lands: say so then, not after the follow-up.
    toast({
      title: current ? "Rules updated" : "Rules set",
      description: "The Policy contract checks every new intent against these rules.",
      tone: "success",
    });
    await onSigned?.(result.hash);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={`Your wallet signs one setPolicy transaction on ${snapshot.network.name}. Every rule is replaced at once.`}
      lightDismiss={false}
      footer={
        finished ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={working}>
              Back to the draft
            </Button>
            <Button
              variant="primary"
              icon={<PenLine aria-hidden />}
              onClick={() => void sign()}
              loading={working}
              disabled={blocked !== null || changes.length === 0}
            >
              Sign in wallet
            </Button>
          </>
        )
      }
    >
      <div className={styles.review} data-testid="policy-review">
        <dl className={styles.changeList}>
          {changes.map((change) => (
            <div key={change.label} className={styles.change}>
              <dt>{change.label}</dt>
              <dd className="num">
                <span className={styles.from}>{change.from}</span> to <strong>{change.to}</strong>
              </dd>
            </div>
          ))}
        </dl>
        {warnings.map((warning) => (
          <p key={warning} className={styles.warning}>
            <TriangleAlert aria-hidden />
            <span>{warning}</span>
          </p>
        ))}
        {blocked && access.kind !== "loading" ? <p className={styles.blockedNote}>{blocked}</p> : null}
        <OwnerTxStatus state={state} />
      </div>
    </Dialog>
  );
}
