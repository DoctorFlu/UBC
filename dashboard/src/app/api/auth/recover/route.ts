import { getConsoleService } from "@/server/console";
import { startRecovery } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Starts adding a passkey with a recovery code. */
export function POST(request: Request) {
  return startRecovery(request, getConsoleService());
}
