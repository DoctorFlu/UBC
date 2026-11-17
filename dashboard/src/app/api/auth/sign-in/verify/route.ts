import { getConsoleService } from "@/server/console";
import { finishSignIn } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Finishes a passkey sign-in with a new session. */
export function POST(request: Request) {
  return finishSignIn(request, getConsoleService());
}
