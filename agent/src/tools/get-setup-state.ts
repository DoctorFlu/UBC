import * as z from "zod";
import type { HoldingsResponse, PairingResponse, PolicySnapshot, Roles } from "@mandate/shared";
import { isConfigured, type Config } from "../config";
import type { ToolContext } from "../context";
import { ok, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, stoppedFailure, unavailableFor } from "../support/failures";
import { SERVER_AGENT, type AgentIdentity } from "../tenancy/agents";

/** Below this the agent cannot pay for a few proposals: 0.01 USDC in Arc's 18-decimal gas units. */
export const MIN_AGENT_GAS_WEI = 10n ** 16n;

const SetupStepSchema = z.object({
  key: z.string().describe("Stable step id"),
  done: z.boolean(),
  actor: z.enum(["agent", "owner"]).describe("Who must act to complete the step"),
  hint: z.string().describe("What to do, in plain language"),
});
type SetupStep = z.infer<typeof SetupStepSchema>;

/**
 * Steps that depend only on the configuration of the agent the call acts for. An agent whose key the
 * console holds has nothing to set on the server: its key and contract come from its workspace.
 */
export function setupSteps(config: Config, agent: AgentIdentity = SERVER_AGENT): SetupStep[] {
  if (agent.signer === "console") {
    return [
      {
        key: "agent_key",
        done: config.agentAddress !== undefined,
        actor: "owner",
        hint: "The console holds this agent's key. Nothing to set on the server.",
      },
      {
        key: "policy_contract",
        done: config.policyAddress !== undefined,
        actor: "owner",
        hint: "This mandate has no Policy contract yet. Until it has one, the agent can plan and explain, but not propose trades.",
      },
      {
        key: "console_link",
        done: true,
        actor: "owner",
        hint: "This agent reaches its workspace in the console with its token.",
      },
    ];
  }
  return [
    {
      key: "agent_key",
      done: isConfigured(config, "AGENT_PRIVATE_KEY"),
      actor: "owner",
      hint: "Set AGENT_PRIVATE_KEY in the server's .env file on the machine that runs the server. Never paste a key into chat.",
    },
    {
      key: "policy_contract",
      done: isConfigured(config, "POLICY_ADDRESS"),
      actor: "owner",
      hint: "Create the mandate in the console, then set POLICY_ADDRESS in the server's .env file to its Policy contract.",
    },
    {
      key: "console_link",
      done: isConfigured(config, "CONSOLE_SERVICE_TOKEN"),
      actor: "owner",
      hint: "Set CONSOLE_SERVICE_TOKEN (and CONSOLE_URL if the console is not on localhost:3000) in the server's .env file so the agent can read the holdings entered in the console.",
    },
  ];
}

/** Runs a read, logging and swallowing an expected failure so one broken dependency does not hide the other steps. */
async function attempt<T>(ctx: ToolContext, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    describeFailure(error, ctx);
    return undefined;
  }
}

/** Every step, including the ones that need live state: the chain, the agent role, gas, pairing and holdings. */
export async function liveSetupSteps(ctx: ToolContext): Promise<SetupStep[]> {
  const steps = setupSteps(ctx.config, ctx.agent);
  const policy = ctx.policy;
  const consoleClient = ctx.console;
  const address = ctx.config.agentAddress;

  const [snapshot, roles, gas, pairingRead, holdings] = await Promise.all([
    policy === undefined ? undefined : attempt<PolicySnapshot>(ctx, () => policy.snapshot()),
    policy === undefined ? undefined : attempt<Roles>(ctx, () => policy.roles()),
    policy === undefined || address === undefined ? undefined : attempt(ctx, () => policy.agentGasBalance()),
    consoleClient === undefined
      ? undefined
      : attempt<{ pairing: PairingResponse | null }>(ctx, async () => ({
          pairing: await consoleClient.getPairing(ctx.signal),
        })),
    consoleClient === undefined
      ? undefined
      : attempt<HoldingsResponse>(ctx, () => consoleClient.getHoldings(ctx.signal)),
  ]);

  if (policy !== undefined) {
    steps.push({
      key: "chain_reachable",
      done: snapshot !== undefined,
      actor: "owner",
      hint: "The server cannot read the Policy contract. Check POLICY_ADDRESS and ARC_RPC_URL in the server's .env file.",
    });
  }
  if (policy !== undefined && address !== undefined) {
    steps.push({
      key: "agent_role",
      done: roles !== undefined && roles.agent.toLowerCase() === address.toLowerCase(),
      actor: "owner",
      hint: `Name ${address} as the mandate's agent in the console, signing with the owner's wallet.`,
    });
    steps.push({
      key: "agent_gas",
      done: typeof gas === "bigint" && gas >= MIN_AGENT_GAS_WEI,
      actor: "owner",
      hint: `Send a little Arc testnet USDC to ${address} for network fees, for example from faucet.circle.com.`,
    });
  }
  if (snapshot !== undefined) {
    const { rules } = snapshot;
    steps.push({
      key: "mandate_rules",
      done: rules.budgetCents > 0 && rules.maxTradeCents > 0 && rules.allowedCategories !== 0,
      actor: "owner",
      hint: "Set a budget, a max trade size and at least one allowed category for the mandate in the console.",
    });
    steps.push({
      key: "not_paused",
      done: !rules.paused,
      actor: "owner",
      hint: "The mandate is paused. Unpause it in the console when the agent may trade again.",
    });
  }
  if (consoleClient !== undefined) {
    steps.push({
      key: "console_reachable",
      done: pairingRead !== undefined || holdings !== undefined,
      actor: "owner",
      hint: "The console did not answer. Start it, and check CONSOLE_URL and that both sides use the same CONSOLE_SERVICE_TOKEN.",
    });
    if (address !== undefined) {
      const pairing = pairingRead?.pairing ?? null;
      steps.push({
        key: "pairing_requested",
        done: pairing !== null,
        actor: "agent",
        hint: "Call request_pairing, then give the owner the claim link it returns.",
      });
      steps.push({
        key: "pairing_confirmed",
        done: pairing?.status === "confirmed",
        actor: "owner",
        hint:
          pairing === null
            ? "Confirm the agent in the console once it has asked to pair."
            : `Open ${pairing.claimUrl} and confirm agent ${pairing.agentAddress}.`,
      });
    }
    steps.push({
      key: "holdings",
      done: holdings !== undefined && holdings.holdings.length > 0,
      actor: "owner",
      hint: "Enter the holdings to protect (asset and quantity) in the console.",
    });
  }
  return steps;
}

export const getSetupState = defineTool({
  name: "get_setup_state",
  title: "List remaining setup steps",
  description:
    "Checks everything this agent needs before it can trade (keys, the Policy contract, the agent role, gas, the console link, pairing, holdings) and lists each step as done or not, with who must act (agent or owner) and a plain hint. Call it at the start of every conversation and after any 'unavailable' result, then tell the owner exactly what is left.",
  inputSchema: z.object({}),
  outputSchema: verdictSchema({
    ready: z.boolean().describe("True when every step is done"),
    steps: z.array(SetupStepSchema),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    const steps = await liveSetupSteps(ctx);
    // Out of time (issue #105): the live steps would read "not done" only because they were slow, so
    // report what was slow and only the steps the configuration alone decides.
    const stopped = stoppedFailure(ctx.deadline);
    if (stopped !== undefined) {
      const v = unavailableFor(stopped);
      return {
        structured: { ...v, ready: false, steps: setupSteps(ctx.config) },
        summary: summarizeVerdict(v),
      };
    }
    const remaining = steps.filter((step) => !step.done);
    const next = remaining[0];
    // The agent can act on its own steps right away; list the owner's after.
    const agentStep = remaining.find((step) => step.actor === "agent");
    const v = ok(
      [],
      next === undefined
        ? { actor: "agent", hint: "Setup is complete: call get_policy and get_portfolio, then plan." }
        : { actor: (agentStep ?? next).actor, hint: (agentStep ?? next).hint },
    );
    return {
      structured: { ...v, ready: next === undefined, steps },
      summary:
        next === undefined
          ? `Setup is complete (${steps.length} of ${steps.length} steps done).`
          : `${steps.length - remaining.length} of ${steps.length} setup steps done. Left: ${remaining
              .map((step) => `${step.actor}: ${step.hint}`)
              .join(" ")}`,
    };
  },
});
