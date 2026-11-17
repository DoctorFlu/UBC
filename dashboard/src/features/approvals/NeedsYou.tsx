"use client";

import type { IntentView } from "@mandate/shared";
import { Cable, MessageSquareDiff } from "lucide-react";

import { AgentReason } from "@/components/domain/AgentReason";
import { ApprovalActions } from "@/components/domain/ApprovalActions";
import {
  FlaggedBadge,
  IntentLink,
  MarketName,
  OrderSummary,
  amountLabel,
  intentFlags,
} from "@/components/domain/Intent";
import { ButtonLink } from "@/components/ui/Button";
import { HexValue } from "@/components/ui/HexValue";
import { When } from "@/components/ui/When";
import { Advanced } from "@/lib/advanced/Advanced";

import type { Attention } from "@/lib/live/attention";
import { agentName, sealedReasonText } from "@/lib/live/derive";
import type { ChainView, ConsoleSnapshot } from "@/lib/live/types";

import styles from "./approvals.module.css";

/** One intent the contract held for the owner: what, how much, the agent's reason, and the decision. */
export function HeldIntent({ intent, chain }: { intent: IntentView; chain: ChainView }) {
  const reason = sealedReasonText(chain, intent.id);
  return (
    <li className={styles.held} data-testid={`waiting-intent-${intent.id.toString()}`}>
      <div className={styles.heldBody}>
        <FlaggedBadge flags={intentFlags(intent)} />
        <div className={styles.heldHead}>
          <MarketName
            symbol={intent.market}
            category={intent.category}
            listing={intent.listing}
            showCategory={false}
          />
          <span className={styles.heldAmount}>{amountLabel(intent)}</span>
        </div>
        <div className={styles.heldMeta}>
          <OrderSummary intent={intent} />
          <span>
            <IntentLink id={intent.id} /> · <When at={intent.proposedAt} />
          </span>
        </div>
        <Advanced>
          <HexValue label="Proposed in" value={intent.proposedTxHash} kind="tx" />
        </Advanced>
        {reason ? <AgentReason text={reason} /> : null}
      </div>
      <div className={styles.heldActions}>
        <ApprovalActions intent={intent} block />
      </div>
    </li>
  );
}

/**
 * Everything waiting for the owner, most urgent first: held intents (signed here), then the agent's
 * requests to change the rules and a pairing to confirm (each opens the page that signs it).
 */
export function NeedsYou({ snapshot, attention }: { snapshot: ConsoleSnapshot; attention: Attention }) {
  const chain = snapshot.chain;
  const name = agentName(snapshot);
  return (
    <div className={styles.needs}>
      {chain && attention.intents.length > 0 ? (
        <ul className={styles.heldGrid}>
          {attention.intents.map((intent) => (
            <HeldIntent key={intent.id} intent={intent} chain={chain} />
          ))}
        </ul>
      ) : null}
      {attention.changeRequests.length > 0 || attention.pairing ? (
        <ul className={styles.tasks}>
          {attention.changeRequests.map((request) => {
            const count = Object.keys(request.proposed).length;
            return (
              <li key={request.id} className={styles.task} data-testid="change-request-task">
                <MessageSquareDiff
                  aria-hidden
                  className={styles.taskIcon}
                  nonScalingStroke
                  strokeWidth={1.5}
                />
                <span className={styles.taskText}>
                  <span className={styles.taskTitle}>
                    {name} asks to change {count.toString()} {count === 1 ? "rule" : "rules"}
                  </span>
                  <span className={styles.taskMeta}>
                    Sent <When inSentence at={request.createdAt} />
                  </span>
                </span>
                <ButtonLink view href="/rules?tab=requests" size="sm" variant="secondary">
                  Review
                </ButtonLink>
              </li>
            );
          })}
          {attention.pairing ? (
            <li className={styles.task} data-testid="pairing-task">
              <Cable aria-hidden className={styles.taskIcon} nonScalingStroke strokeWidth={1.5} />
              <span className={styles.taskText}>
                <span className={styles.taskTitle}>
                  {attention.pairing.agentName} wants to pair with this console
                </span>
                <span className={styles.taskMeta}>
                  Announced <When inSentence at={attention.pairing.announcedAt} />
                </span>
              </span>
              <ButtonLink
                view
                href={`/setup/pair/${attention.pairing.agentAddress}`}
                size="sm"
                variant="secondary"
              >
                Confirm
              </ButtonLink>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
