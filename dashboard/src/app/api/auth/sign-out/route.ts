import { getConsoleService } from "@/server/console";
import { signOut } from "@/server/http/auth-api";

export const dynamic = "force-dynamic";

/** Ends this browser's session. */
export function POST(request: Request) {
  return signOut(request, getConsoleService());
}
