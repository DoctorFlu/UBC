import { getConsoleService } from "@/server/console";
import { dismissChangeRequest } from "@/server/http/owner-api";

export const dynamic = "force-dynamic";

/** The owner dismisses an agent's change request. Signed by the owner's wallet, over the request id. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/console/change-requests/[id]/dismiss">,
) {
  return dismissChangeRequest(request, getConsoleService(), await context.params);
}
