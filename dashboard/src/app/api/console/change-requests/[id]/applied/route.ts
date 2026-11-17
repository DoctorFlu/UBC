import { getConsoleService } from "@/server/console";
import { markChangeRequestApplied } from "@/server/http/owner-api";

export const dynamic = "force-dynamic";

/** Closes a change request once the owner's setPolicy transaction is onchain; the server checks the receipt. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/console/change-requests/[id]/applied">,
) {
  return markChangeRequestApplied(request, getConsoleService(), await context.params);
}
