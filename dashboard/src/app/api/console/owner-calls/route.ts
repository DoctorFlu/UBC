import { getConsoleService } from "@/server/console";
import { postOwnerCall } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** One owner call the console signs, with the passkey confirmation it needs. */
export function POST(request: Request) {
  return postOwnerCall(request, getConsoleService());
}
