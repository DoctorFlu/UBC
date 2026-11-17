import { getConsoleService } from "@/server/console";
import { forwardAuth } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** The reverse proxy's session check for every non-public path. */
export function GET(request: Request) {
  return forwardAuth(request, getConsoleService());
}
