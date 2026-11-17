import { getConsoleService } from "@/server/console";
import { getVenueOrder, putVenueOrder } from "@/server/http/executor-orders-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/executor/v1/orders/[intentId]">) {
  return getVenueOrder(request, getConsoleService(), await context.params);
}

export async function PUT(request: Request, context: RouteContext<"/api/executor/v1/orders/[intentId]">) {
  return putVenueOrder(request, getConsoleService(), await context.params);
}
