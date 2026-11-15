import { getConsoleService } from "@/server/console";
import { getContext, putContext } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/agent/v1/contexts/[hash]">) {
  return getContext(request, getConsoleService(), await context.params);
}

export async function PUT(request: Request, context: RouteContext<"/api/agent/v1/contexts/[hash]">) {
  return putContext(request, getConsoleService(), await context.params);
}
