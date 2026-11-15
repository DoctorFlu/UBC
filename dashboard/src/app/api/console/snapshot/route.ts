import { getConsoleService } from "@/server/console";
import { json } from "@/server/http/responses";

export const dynamic = "force-dynamic";

/** The console's current state as one JSON document (the same object the event stream sends). */
export function GET() {
  return json(getConsoleService().snapshot());
}
