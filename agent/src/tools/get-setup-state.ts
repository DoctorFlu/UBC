import * as z from "zod";
import { isConfigured, type Config } from "../config";
import { defineTool } from "../mcp/tool";

const SetupStepSchema = z.object({
  key: z.string().describe("Stable step id"),
  done: z.boolean(),
  actor: z.enum(["agent", "owner"]).describe("Who must act to complete the step"),
  hint: z.string().describe("What to do, in plain language"),
});
type SetupStep = z.infer<typeof SetupStepSchema>;

/**
 * Setup steps derived from the server's configuration. Issue #32 adds steps that need live state
 * (pairing, funded balances, an active mandate).
 */
export function setupSteps(config: Config): SetupStep[] {
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

export const getSetupState = defineTool({
  name: "get_setup_state",
  title: "List remaining setup steps",
  description:
    "Lists the setup steps for this agent, which are done, and who must do each remaining one (the agent or the owner). Call it at the start of a session or after any 'unavailable' result, then tell the owner what is left.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ready: z.boolean().describe("True when every step is done"),
    steps: z.array(SetupStepSchema),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_input, { config }) => {
    const steps = setupSteps(config);
    const remaining = steps.filter((step) => !step.done);
    const next = remaining[0];
    return {
      structured: { ready: next === undefined, steps },
      summary:
        next === undefined
          ? `Setup is complete (${steps.length} of ${steps.length} steps done).`
          : `${steps.length - remaining.length} of ${steps.length} setup steps done. Next, ${next.actor}: ${next.hint}`,
    };
  },
});
