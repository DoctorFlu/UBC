import { getConsoleService } from "@/server/console";
import { getSettlements } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getSettlements(request, getConsoleService());
}
