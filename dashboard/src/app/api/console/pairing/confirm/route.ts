import { getConsoleService } from "@/server/console";
import { confirmPairing } from "@/server/http/owner-api";

export const dynamic = "force-dynamic";

/** The owner claims an agent that announced itself. Signed by the owner's wallet. */
export function POST(request: Request) {
  return confirmPairing(request, getConsoleService());
}
