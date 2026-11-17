import { getConsoleService } from "@/server/console";
import { listExecutorContracts } from "@/server/http/executor-orders-api";

export const dynamic = "force-dynamic";

/** The contracts whose executor signed the request (#95). */
export async function GET(request: Request) {
  return listExecutorContracts(request, getConsoleService(), {});
}
