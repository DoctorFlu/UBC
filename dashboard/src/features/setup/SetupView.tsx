import { Check } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { HexValue } from "@/components/ui/HexValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { targetChain } from "@/lib/chain";
import type { Agent, SetupStep } from "@/lib/domain";
import { formatCount } from "@/lib/format";

import { DemoControls } from "./DemoControls";
import styles from "./setup.module.css";

export interface SetupData {
  agent: Agent;
  steps: readonly SetupStep[];
  mcpEndpoint: string;
  pairingCode: string;
  policyAddress: string;
}

export function SetupView({ agent, steps, mcpEndpoint, pairingCode, policyAddress }: SetupData) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);

  return (
    <div className={styles.view}>
      <PageHeader
        title="Setup"
        description={`Pair ${agent.name} with this console. ${formatCount(done)} of ${formatCount(steps.length)} steps done.`}
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
            title="MCP server"
            description={`Add this address to ${agent.name} as a connector. It only accepts intents; it cannot move funds.`}
            headingLevel={2}
          >
            <div className={styles.copyRow}>
              <code className={styles.endpoint} translate="no">
                {mcpEndpoint}
              </code>
              <CopyButton value={mcpEndpoint} what="MCP server address" />
            </div>
          </Card>

          <Card
            title="Pairing code"
            description={`When ${agent.name} asks to connect, check that it shows this code before you claim it.`}
            headingLevel={2}
          >
            <div className={styles.copyRow}>
              <span className={styles.code} translate="no">
                {pairingCode}
              </span>
              <CopyButton value={pairingCode} what="pairing code" />
            </div>
          </Card>

          <Card title="Network" headingLevel={2}>
            <dl className={styles.network}>
              <div>
                <dt>Chain</dt>
                <dd>{targetChain.name}</dd>
              </div>
              <div>
                <dt>Chain id</dt>
                <dd className="num">{targetChain.id}</dd>
              </div>
              <div>
                <dt>RPC</dt>
                <dd className="mono">{targetChain.rpcUrls.default.http[0]}</dd>
              </div>
              <div>
                <dt>Policy contract</dt>
                <dd>
                  <HexValue value={policyAddress} kind="address" />
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Demo controls"
            description="For rehearsals. These change only what this tab shows."
            tone="sunken"
            headingLevel={2}
          >
            <DemoControls />
          </Card>
        </div>
      </div>
    </div>
  );
}
