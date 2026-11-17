import { getConsoleService } from "@/server/console";
import { resolveToken } from "@/server/http/agent-auth";

export const dynamic = "force-dynamic";

/** The MCP server asks which agent a bearer token's hash belongs to. */
export function POST(request: Request) {
  return resolveToken(request, getConsoleService());
}
