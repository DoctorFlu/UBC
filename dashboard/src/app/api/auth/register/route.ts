import { getConsoleService } from "@/server/console";
import { finishRegistration } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Finishes any passkey registration this browser started. */
export function POST(request: Request) {
  return finishRegistration(request, getConsoleService());
}
