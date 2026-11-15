"use client";

import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";

import styles from "./mandate.module.css";

/** Accept (hold, or press twice) or decline an agent's change request. Mock until #36. */
export function ChangeRequestActions({ summary }: { summary: string }) {
  const toast = useToast();
  return (
    <div className={styles.requestActions}>
      <HoldButton
        tone="ink"
        icon={<Check aria-hidden />}
        confirmedLabel="Accepted"
        aria-label={`Accept and sign: ${summary}`}
        onConfirm={() => toast({ title: "Change accepted", description: summary, tone: "success" })}
      >
        Accept and sign
      </HoldButton>
      <Button
        variant="secondary"
        icon={<X aria-hidden />}
        aria-label={`Decline: ${summary}`}
        onClick={() => toast({ title: "Change declined", description: summary })}
      >
        Decline
      </Button>
    </div>
  );
}
