import { formatEasternTime } from "@mandate/shared";
import * as z from "zod";
import { defineTool } from "../mcp/tool";
import { DateTextSchema } from "../support/format";
import { SERVER_VERSION } from "../version";

export const ping = defineTool({
  name: "ping",
  title: "Check the Mandate server",
  description:
    "Checks that the Mandate server is reachable and returns its current time and version. Use it to test the connection.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.literal("ok"),
    serverTime: z.string().describe("Server time, ISO 8601 in UTC"),
    serverTimeText: DateTextSchema,
    version: z.string(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_input, ctx) => {
    const now = ctx.clock.now();
    const serverTime = now.toISOString();
    const serverTimeText = formatEasternTime(now);
    return {
      structured: { status: "ok" as const, serverTime, serverTimeText, version: SERVER_VERSION },
      summary: `Mandate server ${SERVER_VERSION} is up. Server time ${serverTimeText} (${serverTime}).`,
    };
  },
});
