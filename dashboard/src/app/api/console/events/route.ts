import { getConsoleService } from "@/server/console";
import { eventStream } from "@/server/http/event-stream";

export const dynamic = "force-dynamic";

/** Server-sent events: the console's live state, pushed after every change. */
export function GET(request: Request) {
  return eventStream(request, getConsoleService());
}
