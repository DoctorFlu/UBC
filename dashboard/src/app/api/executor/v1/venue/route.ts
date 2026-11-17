import { getConsoleService } from "@/server/console";
import { putExecutorVenue } from "@/server/http/executor-orders-api";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return putExecutorVenue(request, getConsoleService(), {});
}
