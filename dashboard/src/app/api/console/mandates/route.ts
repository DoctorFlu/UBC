import { getConsoleService } from "@/server/console";
import { createMandate, listMandates } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** The workspace's mandates. */
export function GET(request: Request) {
  return listMandates(request, getConsoleService());
}

/** A new mandate, its agent and the agent's first token (shown in this answer only). */
export function POST(request: Request) {
  return createMandate(request, getConsoleService());
}
