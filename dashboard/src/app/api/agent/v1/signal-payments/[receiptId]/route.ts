import { getConsoleService } from "@/server/console";
import { putSignalPayment } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/agent/v1/signal-payments/[receiptId]">,
) {
  return putSignalPayment(request, getConsoleService(), await context.params);
}
