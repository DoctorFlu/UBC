"use client";

import { Check } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { formatCount, formatDateUtc, formatTimeUtc } from "@/lib/format";
import { useSnapshot } from "@/lib/live/LiveConsole";
import type { ConsoleSnapshot } from "@/lib/live/types";
import { useOwnerAccess } from "@/lib/owner/access";

import styles from "./setup.module.css";

interface Step {
  id: string;
  title: string;
  hint: string;
  done: boolean;
}

/** Every step is read from somewhere real: the wallet, the contract, or what the agent told the console. */
function setupSteps(snapshot: ConsoleSnapshot, ownerConnected: boolean): Step[] {
  const pairing = snapshot.offchain.pairing;
  return [
    {
      id: "contract",
      title: "Point the console at the Policy contract",
      hint: "Locally, npm run dev:chain deploys one. On Arc testnet, set POLICY_ADDRESS.",
      done: snapshot.contract !== null,
    },
    {
      id: "connect-wallet",
      title: "Connect the owner wallet",
      hint: "The contract's user(): the wallet that signs the mandate, approvals and the kill switch.",
      done: ownerConnected,
    },
    {
      id: "set-mandate",
      title: "Set the first mandate",
      hint: "Budget, max trade size, markets, approval threshold and daily loss limit.",
      done: snapshot.chain?.rules != null,
    },
    {
      id: "add-mcp",
      title: "Add the MCP server to Grok Bot",
      hint: "Done when the agent's MCP server announces itself to this console.",
      done: pairing !== null,
    },
    {
      id: "confirm-agent",
      title: "Confirm the agent",
      hint: "Check the agent's name and address, then sign to confirm it.",
      done: pairing?.status === "confirmed",
    },
    {
      id: "contract-agent",
      title: "The agent's key is the contract's agent",
      hint: "The Policy contract only accepts proposals from agent(). The console reads it directly.",
      done: pairing?.isContractAgent === true,
    },
  ];
}

/** Pairing Grok Bot with this console, as a checklist derived from live state, plus the details to copy. */
export function SetupView({ preview }: { preview?: ConsoleSnapshot }) {
  const live = useSnapshot();
  const snapshot = preview ?? live;
  const access = useOwnerAccess();
  const steps = setupSteps(snapshot, access.kind === "owner");
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
          <Card
            title="Agent pairing"
            description="The agent's MCP server announces itself here; you confirm it with the owner wallet."
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
                      {pairing.status === "confirmed" && pairing.confirmedAt
                        ? `Confirmed ${formatDateUtc(pairing.confirmedAt)} at ${formatTimeUtc(pairing.confirmedAt)}`
                        : `Waiting for you since ${formatTimeUtc(pairing.announcedAt)}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Contract agent</dt>
                    <dd>
                      {pairing.isContractAgent
                        ? "Yes, agent() is this address"
                        : "No, agent() is another address"}
                    </dd>
                  </div>
                </dl>
                {pairing.status === "pending" ? (
                  <ButtonLink href={`/setup/pair/${pairing.agentAddress}`} variant="primary">
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

          <Card
            title="MCP server"
            description="Add this address to Grok Bot as a connector. It only proposes intents; it cannot move funds."
            headingLevel={2}
          >
            {snapshot.mcpPublicUrl ? (
              <div className={styles.copyRow}>
                <code className={styles.endpoint} translate="no">
                  {snapshot.mcpPublicUrl}
                </code>
                <CopyButton value={snapshot.mcpPublicUrl} what="MCP server address" />
              </div>
            ) : (
              <p className={styles.muted}>
                Not configured. Set <code>MCP_PUBLIC_URL</code> on the console to the public address of the
                MCP server.
              </p>
            )}
          </Card>

          <Card title="Network" headingLevel={2}>
            <dl className={styles.network}>
              <div>
                <dt>Chain</dt>
                <dd>{snapshot.network.name}</dd>
              </div>
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
                <dd>{contract ? <HexValue value={contract.address} kind="address" /> : "Not configured"}</dd>
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
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
