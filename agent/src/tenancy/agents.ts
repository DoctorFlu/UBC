/**
 * One context per agent (docs/accounts.md): every MCP call runs with the services of the agent its token
 * resolved to, so a plan id, a retried proposal or a console record of one agent means nothing to another.
 *
 * - The first mandate's agent (`env`) uses the server's own services: its key, its contract, the signal
 *   buyer and the payment outbox.
 * - Any other agent gets its own plan store and proposal ledger, a console client that names it, and a
 *   policy client only when its mandate has a contract, signing through the console (`ConsoleSigner`).
 *   It never gets the signal buyer: signals spend the operator's wallet, which phase 1 keeps for the
 *   first mandate.
 */
import { ENV_AGENT_ID, type SignerKind } from "@mandate/shared";
import { createAgentPolicy } from "../chain/agent-policy";
import type { Config } from "../config";
import type { AppContext } from "../context";
import { ProposalLedger } from "../state/ledger";
import { PlanStore } from "../state/plans";
import { ConsoleSigner } from "./console-signer";
import type { FetchLike, ResolvedAgent } from "./resolver";

/** Who an MCP call acts for. */
export interface AgentIdentity {
  readonly agentId: string;
  /** Null until the console has named it (the server's own context before any call). */
  readonly mandateId: string | null;
  readonly workspaceId: string | null;
  readonly signer: SignerKind;
  /** The contract the mandate follows: `env` is the server's own, null is none yet. */
  readonly deployment: "env" | null;
}

/** The server's own agent before any token has named its mandate. */
export const SERVER_AGENT: AgentIdentity = {
  agentId: ENV_AGENT_ID,
  mandateId: null,
  workspaceId: null,
  signer: "env",
  deployment: "env",
};

export function identityOf(resolved: ResolvedAgent): AgentIdentity {
  return {
    agentId: resolved.agentId,
    mandateId: resolved.mandateId,
    workspaceId: resolved.workspaceId,
    signer: resolved.agent.signer,
    deployment: resolved.mandate.deployment,
  };
}

/** What the console's answer says about an agent that changes its services. */
function fingerprint(resolved: ResolvedAgent): string {
  return JSON.stringify([
    resolved.mandateId,
    resolved.workspaceId,
    resolved.mandate.deployment,
    resolved.agent.signer,
    resolved.agent.address,
  ]);
}

/** Most agents with a context of their own at once; the least recently used one goes first. */
export const MAX_AGENT_CONTEXTS = 500;

export class AgentContexts {
  readonly #base: AppContext;
  readonly #fetch: FetchLike | undefined;
  readonly #contexts = new Map<string, { fingerprint: string; context: AppContext }>();
  /** Plans and proposals outlive a rebuilt context: they are the agent's, whatever its services. */
  readonly #state = new Map<string, { plans: PlanStore; ledger: ProposalLedger }>();

  constructor(base: AppContext, options: { fetch?: FetchLike } = {}) {
    this.#base = base;
    this.#fetch = options.fetch;
  }

  /** The context the call acts in, built once per agent and rebuilt when the console's answer changes. */
  contextFor(resolved: ResolvedAgent): AppContext {
    const key = resolved.agentId;
    const print = fingerprint(resolved);
    const cached = this.#contexts.get(key);
    if (cached?.fingerprint === print) {
      // Map order is insertion order: re-inserting marks it most recently used.
      this.#contexts.delete(key);
      this.#contexts.set(key, cached);
      return cached.context;
    }
    const context = key === ENV_AGENT_ID ? this.#serverAgent(resolved) : this.#workspaceAgent(resolved);
    this.#contexts.delete(key);
    this.#contexts.set(key, { fingerprint: print, context });
    while (this.#contexts.size > MAX_AGENT_CONTEXTS) {
      const oldest = this.#contexts.keys().next().value;
      if (oldest === undefined) break;
      this.#contexts.delete(oldest);
      this.#state.delete(oldest);
    }
    return context;
  }

  #serverAgent(resolved: ResolvedAgent): AppContext {
    const base = this.#base;
    const hasContract = resolved.mandate.deployment === "env";
    return {
      ...base,
      agent: identityOf(resolved),
      policy: hasContract ? base.policy : undefined,
      config: hasContract ? base.config : withoutContract(base.config),
    };
  }

  #workspaceAgent(resolved: ResolvedAgent): AppContext {
    const base = this.#base;
    const state = this.#state.get(resolved.agentId) ?? {
      plans: new PlanStore(),
      ledger: new ProposalLedger(),
    };
    this.#state.set(resolved.agentId, state);
    const address = resolved.agent.address ?? undefined;
    const hasContract = resolved.mandate.deployment === "env";
    const config: Config = {
      ...(hasContract ? base.config : withoutContract(base.config)),
      // The console holds this agent's key: the server never has one for it.
      agentPrivateKey: undefined,
      agentAddress: address,
    };
    const serviceToken = base.config.consoleServiceToken;
    const signer =
      address !== undefined && resolved.agent.signer === "console" && serviceToken !== undefined
        ? new ConsoleSigner({
            address,
            agentId: resolved.agentId,
            baseUrl: base.config.consoleUrl,
            serviceToken,
            ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
          })
        : undefined;
    return {
      ...base,
      config,
      agent: identityOf(resolved),
      policy: hasContract && signer !== undefined ? createAgentPolicy(config, signer) : undefined,
      console: base.console?.forAgent(resolved.agentId),
      payments: undefined,
      paymentReports: undefined,
      plans: state.plans,
      ledger: state.ledger,
    };
  }
}

function withoutContract(config: Config): Config {
  return { ...config, policyAddress: undefined, policyDeployBlock: undefined };
}
