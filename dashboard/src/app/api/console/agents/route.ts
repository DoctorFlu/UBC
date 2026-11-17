import { getConsoleService } from "@/server/console";
import { listAgents } from "@/server/http/agents-api";

export const dynamic = "force-dynamic";

/** The workspace's agents and their tokens. */
export function GET(request: Request) {
  return listAgents(request, getConsoleService());
}
