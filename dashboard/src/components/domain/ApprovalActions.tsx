"use client";

import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";
import type { Intent } from "@/lib/domain";
import { formatUsdCents } from "@/lib/format";

import styles from "./domain.module.css";

/**
 * Approve (hold, or press twice) and Reject for a held intent. Mock for now: #16 signs these
 * with the owner's wallet and the result comes back from chain events.
 */
export function ApprovalActions({ intent, block = false }: { intent: Intent; block?: boolean }) {
  const toast = useToast();
  const amount = formatUsdCents(intent.notionalCents);
  return (
    <div className={styles.approval} data-block={block || undefined}>
      <HoldButton
        tone="ink"
        size="sm"
        block={block}
        icon={<Check aria-hidden />}
        confirmedLabel="Approved"
        aria-label={`Approve ${amount} on ${intent.market.title}`}
        onConfirm={() =>
          toast({ title: "Approved", description: `${amount} on ${intent.market.title}.`, tone: "success" })
        }
      >
        Approve
      </HoldButton>
      <Button
        variant="secondary"
        size="sm"
        block={block}
        icon={<X aria-hidden />}
        aria-label={`Reject ${amount} on ${intent.market.title}`}
        onClick={() => toast({ title: "Rejected", description: `${amount} on ${intent.market.title}.` })}
      >
        Reject
      </Button>
    </div>
  );
}
