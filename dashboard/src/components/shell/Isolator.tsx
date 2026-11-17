"use client";

import { Play, Power } from "lucide-react";

import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";
import { useSnapshot } from "@/lib/live/LiveConsole";
import { signingText } from "@/components/domain/OwnerTxStatus";
import { ownerActionLabel, ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerTx } from "@/lib/owner/useOwnerTx";

import styles from "./Shell.module.css";

/**
 * The kill switch, reachable from every screen: hold to pause, or press twice. It sends the owner's
 * `setPaused`; the paused state then comes back from the contract's `Paused` event, never from here.
 */
export function Isolator({ size = "md" }: { size?: "sm" | "md" }) {
  const snapshot = useSnapshot();
  const toast = useToast();
  const { send, working, access, state } = useOwnerTx();
  const chain = snapshot.chain;
  const paused = chain?.paused ?? false;
  const blocked = chain ? ownerBlockedReason(access) : "The console has not read the Policy contract yet.";
  const disabled = working || blocked !== null;
  const title = working
    ? state.phase === "signing"
      ? signingText(state.via)
      : "Waiting for the chain."
    : (blocked ?? undefined);

  const toggle = async (next: boolean) => {
    const result = await send(next ? "Pause the agent" : "Resume the agent", {
      functionName: "setPaused",
      paused: next,
    });
    if (!result.ok) {
      toast({
        title: next ? "Not paused" : "Not resumed",
        description: result.message,
        ...(result.cancelled ? {} : { tone: "danger" as const }),
      });
      return;
    }
    toast(
      next
        ? {
            title: "Agent paused",
            description: "The Policy contract now rejects every new intent.",
            tone: "danger",
          }
        : { title: "Agent resumed", description: "New intents are checked against the rules again." },
    );
  };

  if (paused) {
    return (
      <span title={title} className={styles.isolatorSlot}>
        <HoldButton
          tone="ink"
          size={size}
          icon={<Play aria-hidden />}
          confirmedLabel="Resuming"
          armedLabel={ownerActionLabel(access, "Resume")}
          disabled={disabled}
          onConfirm={() => void toggle(false)}
        >
          <span className={styles.longLabel}>
            {working ? "Resuming agent" : ownerActionLabel(access, "Resume agent")}
          </span>
          <span className={styles.shortLabel}>Resume</span>
        </HoldButton>
      </span>
    );
  }

  return (
    <span title={title} className={styles.isolatorSlot}>
      <HoldButton
        tone="danger"
        size={size}
        icon={<Power aria-hidden />}
        confirmedLabel="Pausing"
        armedLabel="Confirm pause"
        disabled={disabled}
        onConfirm={() => void toggle(true)}
      >
        <span className={styles.longLabel}>{working ? "Pausing agent" : "Pause agent"}</span>
        <span className={styles.shortLabel}>Pause</span>
      </HoldButton>
    </span>
  );
}
