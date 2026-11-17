import { getConsoleService } from "@/server/console";
import { startClaim } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Starts claiming the first workspace with the operator's claim code. */
export function POST(request: Request) {
  return startClaim(request, getConsoleService());
}
