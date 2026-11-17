import { getConsoleService } from "@/server/console";
import { health } from "@/server/http/health";
import { consoleMarketData } from "@/server/market/quotes";

export const dynamic = "force-dynamic";

/** Liveness for the container's health check and the hosting smoke test. Public; says nothing private. */
export function GET() {
  return health(getConsoleService(), consoleMarketData);
}
