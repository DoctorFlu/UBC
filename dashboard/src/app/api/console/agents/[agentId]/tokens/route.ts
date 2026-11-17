import { getConsoleService } from "@/server/console";
import { createToken } from "@/server/http/agents-api";

export const dynamic = "force-dynamic";

/** Creates a token for one of the workspace's agents; the answer is the only time it is shown. */
export async function POST(request: Request, context: RouteContext<"/api/console/agents/[agentId]/tokens">) {
  return createToken(request, getConsoleService(), await context.params);
}
