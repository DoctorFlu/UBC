import * as z from "zod";
import { held, ok, reason, summarizeVerdict, verdictSchema } from "../mcp/envelope";
import { defineTool } from "../mcp/tool";
import { describeFailure, notConfigured, unavailableFor } from "../support/failures";
import { SERVER_VERSION } from "../version";

export const PairingViewSchema = z.object({
  agentAddress: z.string(),
  agentName: z.string(),
  status: z.enum(["pending", "confirmed"]),
  claimUrl: z.string().describe("Console page where the owner confirms this agent. Safe to show in chat"),
  isContractAgent: z.boolean().describe("The Policy contract already names this address as its agent"),
});

export const requestPairing = defineTool({
  name: "request_pairing",
  title: "Ask the owner to pair this agent",
  description:
    "Announces this agent to the owner's console and returns a claim link. Give the link to the owner: they open it, check the agent's address and confirm. Safe to call again; it returns the current pairing state. The link contains no secret.",
  inputSchema: z.object({
    agentName: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .default("Grok Bot")
      .describe("How the console should name this agent"),
  }),
  outputSchema: verdictSchema({ pairing: PairingViewSchema.nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (ctx.console === undefined || ctx.config.agentAddress === undefined) {
      const v = unavailableFor(
        ctx.console === undefined ? notConfigured.console() : notConfigured.agentKey(),
      );
      return { structured: { ...v, pairing: null }, summary: summarizeVerdict(v) };
    }
    let pairing;
    try {
      pairing = await ctx.console.putPairing(
        { agentAddress: ctx.config.agentAddress, agentName: input.agentName, serverVersion: SERVER_VERSION },
        ctx.signal,
      );
    } catch (error) {
      const v = unavailableFor(describeFailure(error, ctx));
      return { structured: { ...v, pairing: null }, summary: summarizeVerdict(v) };
    }
    const view = {
      agentAddress: pairing.agentAddress,
      agentName: pairing.agentName,
      status: pairing.status,
      claimUrl: pairing.claimUrl,
      isContractAgent: pairing.isContractAgent,
    };
    if (pairing.status === "pending") {
      const v = held([reason("OWNER_CONFIRMS", "The owner has not confirmed this agent yet.")], {
        actor: "owner",
        hint: `Open ${pairing.claimUrl}, check the address ${pairing.agentAddress}, and confirm the agent.`,
      });
      return {
        structured: { ...v, pairing: view },
        summary: `Pairing requested. Ask the owner to open ${pairing.claimUrl} and confirm agent ${pairing.agentAddress}.`,
      };
    }
    const v = ok(
      pairing.isContractAgent
        ? []
        : [
            reason(
              "NOT_THE_AGENT",
              "The owner confirmed this agent, but the contract does not name it as its agent yet.",
            ),
          ],
      pairing.isContractAgent
        ? { actor: "agent", hint: "Call get_setup_state to see if anything else is left." }
        : { actor: "owner", hint: "Set this agent's address as the mandate's agent in the console." },
    );
    return {
      structured: { ...v, pairing: view },
      summary: `The owner has confirmed agent ${pairing.agentAddress}.${pairing.isContractAgent ? "" : " The contract does not name it as its agent yet."}`,
    };
  },
});
