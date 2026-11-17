import { getConsoleService } from "@/server/console";
import { startAddPasskey } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Starts adding another passkey for the signed-in member. */
export function POST(request: Request) {
  return startAddPasskey(request, getConsoleService());
}
