"use client";

import { Link2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type Address, isAddressEqual } from "viem";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { PairingView } from "@/lib/live/types";
import { ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerRequest } from "@/lib/owner/useOwnerRequest";

import styles from "./setup.module.css";

/**
 * The page the agent's MCP server links the owner to. The owner checks the name and address it
 * announced, then signs to confirm. Confirming tells the console which agent is theirs; it changes
 * nothing onchain, where only `agent()` can propose.
 */
export function PairClaimView({ address, initial }: { address: Address; initial: PairingView | null }) {
  const snapshot = useSnapshot();
  const toast = useToast();
  const router = useRouter();
  const { request, pending, access } = useOwnerRequest();
  const latest = snapshot.offchain.pairing;
  const pairing = latest && isAddressEqual(latest.agentAddress, address) ? latest : initial;
  const blocked = ownerBlockedReason(access);
  const contractAgent = snapshot.contract?.roles?.agent ?? null;

  if (!pairing) {
    return (
      <div className={styles.claim}>
        <PageHeader title="Confirm the agent" />
        <EmptyState
          icon={<Link2 strokeWidth={1.75} />}
          title="No agent with this address asked to pair"
          action={<ButtonLink href="/setup">Back to setup</ButtonLink>}
        >
          Start the agent&apos;s MCP server: it announces itself to this console and links you here.
        </EmptyState>
      </div>
    );
  }

  const confirm = async () => {
    const result = await request("/api/console/pairing/confirm", "POST", "pairing.confirm", {
      agentAddress: pairing.agentAddress,
    });
    // The live snapshot carries only the latest pairing: refresh so this page shows this one confirmed.
    if (result.ok) router.refresh();
    toast(
      result.ok
        ? {
            title: "Agent confirmed",
            description: `${pairing.agentName} is paired with this console.`,
            tone: "success",
          }
        : { title: "Not confirmed", description: result.message, tone: "danger" },
    );
  };

  return (
    <div className={styles.claim}>
      <PageHeader
        title="Confirm the agent"
        description={`${pairing.agentName} asked to pair with this console. Check it is your agent before you confirm.`}
      />
      <Card
        headingLevel={2}
        title={pairing.agentName}
        tone={pairing.status === "pending" ? "attention" : "default"}
      >
        <div className={styles.pairing} data-testid="pair-claim" data-status={pairing.status}>
          <dl className={styles.network}>
            <div>
              <dt>Agent address</dt>
              <dd>
                <HexValue value={pairing.agentAddress} kind="address" />
              </dd>
            </div>
            <div>
              <dt>MCP server version</dt>
              <dd className="mono">{pairing.serverVersion}</dd>
            </div>
            <div>
              <dt>Asked</dt>
              <dd>
                {formatDateUtc(pairing.announcedAt)} at {formatTimeUtc(pairing.announcedAt)}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {pairing.status === "confirmed" && pairing.confirmedAt
                  ? `Confirmed ${formatDateUtc(pairing.confirmedAt)} at ${formatTimeUtc(pairing.confirmedAt)}`
                  : "Waiting for you"}
              </dd>
            </div>
          </dl>
          {pairing.isContractAgent ? null : (
            <p className={styles.muted}>
              <TriangleAlert aria-hidden width={14} height={14} /> The Policy contract&apos;s agent is{" "}
              {contractAgent ? <HexValue value={contractAgent} kind="address" /> : "unknown"}, not this
              address. The contract will reject its proposals until the owner points <code>agent()</code> at
              it.
            </p>
          )}
          {pairing.status === "pending" ? (
            <div className={styles.claimActions}>
              <Button
                variant="primary"
                onClick={() => void confirm()}
                loading={pending}
                disabled={blocked !== null}
              >
                Sign and confirm
              </Button>
              {blocked && access.kind !== "loading" ? <span className={styles.muted}>{blocked}</span> : null}
            </div>
          ) : (
            <ButtonLink href="/setup" variant="secondary">
              Back to setup
            </ButtonLink>
          )}
        </div>
      </Card>
    </div>
  );
}
