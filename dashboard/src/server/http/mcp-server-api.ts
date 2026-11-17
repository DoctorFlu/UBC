import { type McpServerStatus, publicMcpUrlSchema } from "@/lib/setup-mcp";

import { json } from "./responses";
import { WORKSPACE, consoleRoute } from "./session";

/** How long Setup waits for the local MCP server's health before saying it is not running. */
const HEALTH_TIMEOUT_MS = 1_500;

/**
 * GET /api/console/mcp-server: the address to give Grok Bot. `MCP_PUBLIC_URL` when it is set; otherwise
 * the MCP server on this machine, whether it answers, and the public address a tunnel last reached it at.
 */
export const getMcpServer = consoleRoute(async (_request, service) => {
  const { mcpPublicUrl, mcpLocalUrl } = service.config;
  if (mcpPublicUrl !== null) return json({ kind: "configured", url: mcpPublicUrl } satisfies McpServerStatus);
  if (mcpLocalUrl === null) return json({ kind: "unknown" } satisfies McpServerStatus);
  const localUrl = `${mcpLocalUrl}/mcp`;
  let publicUrl: string | null = null;
  let running = false;
  try {
    const response = await fetch(`${mcpLocalUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (response.ok) {
      running = true;
      const body = (await response.json()) as { publicMcpUrl?: unknown };
      const parsed = publicMcpUrlSchema.safeParse(body.publicMcpUrl ?? null);
      publicUrl = parsed.success ? parsed.data : null;
    }
  } catch {
    running = false;
  }
  return json({ kind: "local", localUrl, running, publicUrl } satisfies McpServerStatus);
}, WORKSPACE);
