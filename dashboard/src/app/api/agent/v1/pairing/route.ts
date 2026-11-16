import { getConsoleService } from "@/server/console";
import { getPairing, putPairing } from "@/server/http/agent-api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getPairing(request, getConsoleService());
}

export function PUT(request: Request) {
  return putPairing(request, getConsoleService());
}
