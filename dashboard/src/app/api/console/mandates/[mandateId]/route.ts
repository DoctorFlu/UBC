import { getConsoleService } from "@/server/console";
import { patchMandate } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** Renames the mandate (an admin's session; recorded in its owner actions). */
export async function PATCH(request: Request, context: RouteContext<"/api/console/mandates/[mandateId]">) {
  return patchMandate(request, getConsoleService(), await context.params);
}
