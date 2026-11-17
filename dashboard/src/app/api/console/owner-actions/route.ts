import { getConsoleService } from "@/server/console";
import { listOwnerActions } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** The owner calls the console signed for this mandate: who authorised each, with which passkey. */
export function GET(request: Request) {
  return listOwnerActions(request, getConsoleService());
}
