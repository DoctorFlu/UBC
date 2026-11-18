"use client";

import { Check } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ExplorerLink } from "@/components/ui/ExplorerLink";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { formatCount } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { useMandateScope } from "@/lib/mandate/MandateContext";
import { useOwnerAccess, useOwnerMode } from "@/lib/owner/access";
import { setupSteps } from "@/lib/setup";
import { Advanced } from "@/lib/advanced/Advanced";
import { When } from "@/components/ui/When";

import { AgentsSection } from "./AgentsSection";
import { DeployCard } from "./DeployCard";
import { McpServerCard } from "./McpServerCard";
import { RenameCard } from "./RenameCard";
import styles from "./setup.module.css";
import { WakeUpsCard } from "./WakeUps";

/** Pairing Grok Bot with this console, as a checklist derived from live state, plus the details to copy. */
export function SetupView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const access = useOwnerAccess();
  const mode = useOwnerMode();
  const scope = useMandateScope();
  const steps = setupSteps(snapshot, access.kind === "owner", mode);
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  const pairing = snapshot.offchain.pairing;
  const contract = snapshot.contract;

  return (
    <div className={styles.view}>
      <PageHeader
        title="Setup"
        description={`Pair Grok Bot with this console. ${formatCount(done)} of ${formatCount(steps.length)} steps done.`}
      />

      <DeployCard />

      <div className={styles.layout}>
        <Card title="Pairing checklist" headingLevel={2} className={styles.checklist}>
          <ol className={styles.steps}>
            {steps.map((step, index) => (
              <li
                key={step.id}
                className={styles.step}
                data-state={step.done ? "done" : step === next ? "next" : "todo"}
                aria-current={step === next ? "step" : undefined}
              >
                <span className={styles.marker} aria-hidden>
                  {step.done ? <Check strokeWidth={2.5} /> : index + 1}
                </span>
                <div className={styles.stepText}>
                  <span className={styles.stepTitle}>
                    {step.title}
                    <span className="visually-hidden">{step.done ? " (done)" : " (to do)"}</span>
                  </span>
                  <span className={styles.stepHint}>{step.hint}</span>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className={styles.side}>
          {/* Keyed by mandate: the switcher opens another mandate's Setup with its own name. */}
          {preview ? null : <RenameCard key={scope?.mandate.id} />}
          <Card
            title="Agent pairing"
            description={
              mode === "passkey"
                ? "The agent's MCP server announces itself here; you confirm it with your passkey."
                : "The agent's MCP server announces itself here; you confirm it with the owner wallet."
            }
            headingLevel={2}
            tone={pairing?.status === "pending" ? "attention" : "default"}
          >
            {pairing ? (
              <div className={styles.pairing} data-testid="pairing-card" data-status={pairing.status}>
                <dl className={styles.network}>
                  <div>
                    <dt>Agent</dt>
                    <dd>{pairing.agentName}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd>
                      <HexValue value={pairing.agentAddress} kind="address" />
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {pairing.status === "confirmed" && pairing.confirmedAt ? (
                        <>
                          Confirmed <When inSentence at={pairing.confirmedAt} date />
                        </>
                      ) : (
                        <>
                          Waiting for you since <When inSentence at={pairing.announcedAt} />
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Can propose</dt>
                    <dd>
                      {pairing.isContractAgent
                        ? "Yes, the contract accepts proposals from this address"
                        : "No, the contract expects another agent address"}
                    </dd>
                  </div>
                </dl>
                {pairing.status === "pending" ? (
                  <ButtonLink view href={`/setup/pair/${pairing.agentAddress}`} variant="primary">
                    Review and confirm
                  </ButtonLink>
                ) : null}
              </div>
            ) : (
              <EmptyState plain title="No agent has asked to pair">
                Add the MCP server below to Grok Bot. When it starts, it announces itself here and gives you a
                link to confirm it.
              </EmptyState>
            )}
          </Card>

          <McpServerCard configured={snapshot.mcpPublicUrl} ask={!preview} />

          <Card title="Network" headingLevel={2}>
            <dl className={styles.network}>
              <div>
                <dt>Chain</dt>
                <dd>{snapshot.network.name}</dd>
              </div>
              <Advanced
                fallback={
                  // On a public chain, the contract and its roles open on the explorer; Advanced shows the hashes.
                  contract && snapshot.network.explorerUrl ? (
                    <div>
                      <dt>On the explorer</dt>
                      <dd className={styles.explorerLinks}>
                        <ExplorerLink kind="address" value={contract.address}>
                          Policy contract
                        </ExplorerLink>
                        {contract.roles ? (
                          <>
                            <ExplorerLink kind="address" value={contract.roles.user}>
                              Owner
                            </ExplorerLink>
                            <ExplorerLink kind="address" value={contract.roles.agent}>
                              Agent
                            </ExplorerLink>
                            <ExplorerLink kind="address" value={contract.roles.executor}>
                              Executor
                            </ExplorerLink>
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null
                }
              >
                <div>
                  <dt>Chain id</dt>
                  <dd className="num">{snapshot.network.chainId}</dd>
                </div>
                <div>
                  <dt>RPC</dt>
                  <dd className="mono">{snapshot.network.rpcUrl}</dd>
                </div>
                <div>
                  <dt>Policy contract</dt>
                  <dd>
                    {contract ? <HexValue value={contract.address} kind="address" /> : "Not configured"}
                  </dd>
                </div>
                {contract?.roles ? (
                  <>
                    <div>
                      <dt>Owner</dt>
                      <dd>
                        <HexValue value={contract.roles.user} kind="address" />
                      </dd>
                    </div>
                    <div>
                      <dt>Agent</dt>
                      <dd>
                        <HexValue value={contract.roles.agent} kind="address" />
                      </dd>
                    </div>
                    <div>
                      <dt>Executor</dt>
                      <dd>
                        <HexValue value={contract.roles.executor} kind="address" />
                      </dd>
                    </div>
                  </>
                ) : null}
              </Advanced>
            </dl>
          </Card>

          <Advanced>
            <WakeUpsCard wake={snapshot.wake} />
          </Advanced>
        </div>
      </div>

      {/* The fixture preview has no workspace to list agents from. */}
      {preview ? null : <AgentsSection />}
    </div>
  );
}
