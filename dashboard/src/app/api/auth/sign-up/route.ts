import { getConsoleService } from "@/server/console";
import { startSignUp } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Starts creating a workspace: passkey options for a new member. */
export function POST(request: Request) {
  return startSignUp(request, getConsoleService());
}
