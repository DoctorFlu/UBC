import { getConsoleService } from "@/server/console";
import { putSignalBudget } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return putSignalBudget(request, getConsoleService());
}
