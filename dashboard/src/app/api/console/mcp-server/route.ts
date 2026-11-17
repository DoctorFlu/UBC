import { getConsoleService } from "@/server/console";
import { getMcpServer } from "@/server/http/mcp-server-api";

export const dynamic = "force-dynamic";

/** The MCP server's address for Grok Bot: configured, or the one on this machine and its tunnel. */
export function GET(request: Request) {
  return getMcpServer(request, getConsoleService());
}
