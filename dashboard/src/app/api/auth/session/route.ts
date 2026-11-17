import { getConsoleService } from "@/server/console";
import { currentSession } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Who is signed in. */
export function GET(request: Request) {
  return currentSession(request, getConsoleService());
}
