import { getConsoleService } from "@/server/console";
import { getPolicyChangeRequest } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/agent/v1/policy-change-requests/[id]">,
) {
  return getPolicyChangeRequest(request, getConsoleService(), await context.params);
}
