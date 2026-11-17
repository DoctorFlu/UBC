import { getConsoleService } from "@/server/console";
import { postWakeClock } from "@/server/http/dev-api";

export const dynamic = "force-dynamic";

/** Moves the wake-ups' test clock forward (`GROK_WAKE_TEST_CLOCK=on` only). */
export function POST(request: Request) {
  return postWakeClock(request, getConsoleService());
}
