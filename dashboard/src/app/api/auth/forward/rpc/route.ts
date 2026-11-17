import { getConsoleService } from "@/server/console";
import { forwardRpcAuth } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** The reverse proxy's check for the demo chain's RPC. */
export function GET(request: Request) {
  return forwardRpcAuth(request, getConsoleService());
}
