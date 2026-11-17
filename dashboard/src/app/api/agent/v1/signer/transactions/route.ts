import { getConsoleService } from "@/server/console";
import { signTransaction } from "@/server/http/agent-auth";

export const dynamic = "force-dynamic";

/** Signs a proposeTrade for an agent whose key the console holds. */
export function POST(request: Request) {
  return signTransaction(request, getConsoleService());
}
