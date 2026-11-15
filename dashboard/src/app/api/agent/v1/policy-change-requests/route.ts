import { getConsoleService } from "@/server/console";
import { postPolicyChangeRequest } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return postPolicyChangeRequest(request, getConsoleService());
}
