import { getConsoleService } from "@/server/console";
import { startStepUp } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** A passkey challenge bound to one owner action. */
export function POST(request: Request) {
  return startStepUp(request, getConsoleService());
}
