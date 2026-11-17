import { getConsoleService } from "@/server/console";
import { putExecutorVenue } from "@/server/http/executor-orders-api";
import { consoleMarketData } from "@/server/market/quotes";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return putExecutorVenue(consoleMarketData)(request, getConsoleService(), {});
}
