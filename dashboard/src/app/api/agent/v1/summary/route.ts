import { getConsoleService } from "@/server/console";
import { getSummary } from "@/server/http/agent-api";
import { getMarketQuotes } from "@/server/market/quotes";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getSummary(request, getConsoleService(), (asset, eventTicker) =>
    getMarketQuotes().ladder(asset, eventTicker),
  );
}
