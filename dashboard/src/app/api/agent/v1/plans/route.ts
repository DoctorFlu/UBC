import { getConsoleService } from "@/server/console";
import { postPlan } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return postPlan(request, getConsoleService());
}
