import { getConsoleService } from "@/server/console";
import { getHedgeMarket } from "@/server/http/hedge-api";
import { getMarketQuotes } from "@/server/market/quotes";

export const dynamic = "force-dynamic";

/** Live ladder quotes for the hedge view, and a labelled preview plan when the agent has none. */
export function GET(request: Request) {
  return getHedgeMarket(request, getConsoleService(), getMarketQuotes());
}
