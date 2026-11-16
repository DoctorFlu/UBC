import { getConsoleService } from "@/server/console";
import { saveHoldings } from "@/server/http/owner-api";

export const dynamic = "force-dynamic";

/** The owner saves the holdings the agent hedges. Signed by the owner's wallet. */
export function PUT(request: Request) {
  return saveHoldings(request, getConsoleService());
}
