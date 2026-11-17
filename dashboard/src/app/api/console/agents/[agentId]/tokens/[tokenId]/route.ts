import { getConsoleService } from "@/server/console";
import { revokeToken } from "@/server/http/agents-api";

export const dynamic = "force-dynamic";

/** Revokes one of the agent's tokens at once. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/console/agents/[agentId]/tokens/[tokenId]">,
) {
  return revokeToken(request, getConsoleService(), await context.params);
}
