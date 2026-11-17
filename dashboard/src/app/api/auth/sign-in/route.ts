import { getConsoleService } from "@/server/console";
import { startSignIn } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Starts a passkey sign-in. */
export function POST(request: Request) {
  return startSignIn(request, getConsoleService());
}
