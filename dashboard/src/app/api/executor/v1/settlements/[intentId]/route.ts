import { getConsoleService } from "@/server/console";
import { putSettlement } from "@/server/http/executor-api";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/executor/v1/settlements/[intentId]">,
) {
  return putSettlement(request, getConsoleService(), await context.params);
}
