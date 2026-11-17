import * as z from "zod";
import { capabilitiesOf } from "../capabilities";
import { rpcHost } from "../config";
import { defineTool } from "../mcp/tool";

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const whoami = defineTool({
  name: "whoami",
  title: "Show this agent's identity",
  description:
    "Returns this agent's public address on Arc, the RPC host and Policy contract it is configured for, and which capabilities are set up. Never returns keys.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    agentAddress: AddressSchema.nullable().describe(
      "The agent's public Arc address, or null if no agent key is set",
    ),
    agent: z
      .object({
        id: z.string().describe("The agent this token acts for, as the console's Agents section names it"),
        mandateId: z.string().nullable().describe("The mandate it acts on"),
        mandateName: z
          .string()
          .nullable()
          .describe("That mandate's name, as its owners named it; a workspace may have several mandates"),
      })
      .describe("Which agent and mandate the bearer token reaches"),
    chain: z.object({ rpcHost: z.string().describe("Host of the Arc RPC endpoint the server uses") }),
    policyAddress: AddressSchema.nullable(),
    capabilities: z.object({
      readPolicy: z.boolean(),
      proposeTrades: z.boolean(),
      console: z.boolean(),
    }),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_input, { config, agent }) => {
    const capabilities = capabilitiesOf(config);
    const enabled = Object.entries(capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const address = config.agentAddress ?? null;
    return {
      structured: {
        agentAddress: address,
        agent: { id: agent.agentId, mandateId: agent.mandateId, mandateName: agent.mandateName },
        chain: { rpcHost: rpcHost(config) },
        policyAddress: config.policyAddress ?? null,
        capabilities,
      },
      summary: `Agent ${agent.agentId}${
        agent.mandateId === null
          ? ""
          : ` of mandate ${agent.mandateName === null ? agent.mandateId : `"${agent.mandateName}" (${agent.mandateId})`}`
      }. ${
        address === null ? "No agent key is configured." : `Agent address ${address}.`
      } Capabilities: ${enabled.length === 0 ? "none yet; call get_setup_state" : enabled.join(", ")}.`,
    };
  },
});
