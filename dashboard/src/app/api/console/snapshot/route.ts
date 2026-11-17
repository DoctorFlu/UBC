import { getConsoleService } from "@/server/console";
import { json } from "@/server/http/responses";
import { consoleRoute } from "@/server/http/session";

export const dynamic = "force-dynamic";

const snapshot = consoleRoute((_request, service, { mandate }) => json(service.snapshot(mandate)));

/** The session's mandate's current state as one JSON document (the same object the event stream sends). */
export function GET(request: Request) {
  return snapshot(request, getConsoleService());
}
