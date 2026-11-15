import * as z from "zod";
import { capabilitiesOf } from "../capabilities";
import { rpcHost } from "../config";
import { defineTool } from "../mcp/tool";

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const whoami = defineTool({
  name: "whoami",
  title: "Show this agent's identity",
  description:
    "Returns this agent's public address on Arc, the chain RPC host and Policy contract it is configured for, and which capabilities are set up. Never returns keys.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    agentAddress: AddressSchema.nullable().describe(
      "The agent's public Arc address, or null if no agent key is set",
    ),
    chain: z.object({ rpcHost: z.string().nullable() }),
    policyAddress: AddressSchema.nullable(),
    capabilities: z.object({
      readPolicy: z.boolean(),
      proposeTrades: z.boolean(),
      console: z.boolean(),
      buySignals: z.boolean(),
    }),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_input, { config }) => {
    const capabilities = capabilitiesOf(config);
    const enabled = Object.entries(capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const address = config.agentAddress ?? null;
    return {
      structured: {
        agentAddress: address,
        chain: { rpcHost: rpcHost(config) ?? null },
        policyAddress: config.policyAddress ?? null,
        capabilities,
      },
      summary: `${address === null ? "No agent key is configured." : `Agent address ${address}.`} Capabilities: ${
        enabled.length === 0 ? "none yet; call get_setup_state" : enabled.join(", ")
      }.`,
    };
  },
});
