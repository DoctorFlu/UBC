import { getConsoleService } from "@/server/console";
import { getIntentContext, putIntentContext } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/agent/v1/intents/[intentId]/context">,
) {
  return getIntentContext(request, getConsoleService(), await context.params);
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/agent/v1/intents/[intentId]/context">,
) {
  return putIntentContext(request, getConsoleService(), await context.params);
}
