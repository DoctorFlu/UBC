import { getConsoleService } from "@/server/console";
import { getHoldings } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getHoldings(request, getConsoleService());
}
